/**
 * dsh-sound2text — host half.
 *
 * Owns the whole audio pipeline outside the browser: it spawns the Python
 * capture helper on demand, receives completed speech segments from it over
 * loopback HTTP, forwards them to an OpenAI-compatible transcription API
 * (SiliconFlow by default), archives the text, and streams every result to
 * the browser panel over SSE. The browser never talks to the ASR provider,
 * so the API key never leaves this process.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '../types.ts'

export const name = 'dsh-sound2text'

// The route carrier service; without it there is nothing to listen on.
export const inject = ["webServer"]

export interface PluginConfig {
  /** Python executable that runs the capture helper. */
  python?: string
  /** ASR API key; S2T_API_KEY wins when both are set. */
  apiKey?: string
  /** OpenAI-compatible base URL. */
  baseUrl?: string
  /** Transcription model id. */
  model?: string
  /** Optional language hint passed to the API (e.g. "zh" for whisper models). */
  language?: string
  /** Directory for daily transcript archives. */
  archiveDir?: string
  /** Fixed segment-upload token for tests (S2T_DEV_TOKEN env also works). */
  devToken?: string
}

const PREFIX = '/api/sound2text'

class FatalAsrError extends Error {}

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function apply(ctx: Context, rawConfig: PluginConfig = {}) {
  const cfg = rawConfig
  const log = (level: 'info' | 'warn' | 'error', msg: string) => {
    const line = `[sound2text] ${msg}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  const baseUrl = () => (cfg.baseUrl ?? process.env.S2T_BASE_URL ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
  const model = () => cfg.model ?? process.env.S2T_MODEL ?? 'FunAudioLLM/SenseVoiceSmall'
  const language = () => cfg.language ?? process.env.S2T_LANGUAGE ?? ''
  const apiKey = () => cfg.apiKey ?? process.env.S2T_API_KEY ?? ''
  const python = () => cfg.python ?? process.env.S2T_PYTHON ?? 'python'
  const archiveDir = () => cfg.archiveDir ?? process.env.S2T_ARCHIVE_DIR ?? path.join(homedir(), '.dsh', 'sound2text', 'transcripts')

  // ---- state ----------------------------------------------------------------
  let helper: ChildProcess | undefined
  let helperToken = ''
  let lastError = ''
  const sseClients = new Set<ServerResponse>()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  // Serialize ASR calls so transcript order matches audio order.
  let asrChain: Promise<unknown> = Promise.resolve()

  function broadcast(event: Record<string, unknown>) {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of sseClients) res.write(frame)
  }

  // ---- SSE --------------------------------------------------------------------
  function handleEvents(_req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ type: 'status', running: !!helper, hasKey: !!apiKey(), model: model(), lastError })}\n\n`)
    sseClients.add(res)
    res.on('close', () => sseClients.delete(res))
  }

  // ---- helper process ---------------------------------------------------------
  function startHelper(): { ok: boolean; message: string } {
    if (helper) return { ok: true, message: 'already running' }
    const port = ctx.webServer?.port
    if (!port) return { ok: false, message: 'web server port unknown' }
    helperToken = cfg.devToken ?? process.env.S2T_DEV_TOKEN ?? randomBytes(16).toString('hex')
    const helperDir = path.join(pkgRoot, 'helper')
    try {
      helper = spawn(python(), [path.join(helperDir, 'main.py'), '--port', String(port), '--token', helperToken], {
        cwd: helperDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      helper = undefined
      const message = `无法启动 Python 助手 (${python()}): ${e}`
      lastError = message
      broadcast({ type: 'error', message })
      return { ok: false, message }
    }
    helper.stdout?.on('data', (d: Buffer) => log('info', d.toString().trimEnd()))
    helper.stderr?.on('data', (d: Buffer) => log('warn', d.toString().trimEnd()))
    helper.on('error', (e) => {
      lastError = `Python 助手启动失败: ${e.message}（检查 config.python / S2T_PYTHON）`
      log('error', lastError)
      broadcast({ type: 'error', message: lastError })
      helper = undefined
      broadcast({ type: 'status', running: false, hasKey: !!apiKey(), model: model(), lastError })
    })
    helper.on('exit', (code) => {
      const wasRunning = !!helper
      helper = undefined
      if (wasRunning) {
        log('info', `helper exited (${code})`)
        broadcast({ type: 'status', running: false, hasKey: !!apiKey(), model: model(), lastError })
      }
    })
    log('info', `helper started: ${python()} (port ${port})`)
    broadcast({ type: 'status', running: true, hasKey: !!apiKey(), model: model(), lastError })
    return { ok: true, message: 'started' }
  }

  function stopHelper() {
    if (!helper) return
    const proc = helper
    helper = undefined // suppress the exit handler's "unexpected" status flip
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
    broadcast({ type: 'status', running: false, hasKey: !!apiKey(), model: model(), lastError })
  }

  // ---- ASR --------------------------------------------------------------------
  async function transcribe(wav: Buffer): Promise<string> {
    const key = apiKey()
    if (!key) throw new FatalAsrError('未配置语音识别 API Key（环境变量 S2T_API_KEY 或插件 config.apiKey）')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'segment.wav')
    form.append('model', model())
    if (language()) form.append('language', language())
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${baseUrl()}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        })
        if (res.ok) {
          const j = (await res.json()) as { text?: string }
          return (j.text ?? '').trim()
        }
        const body = await res.text()
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`)
        throw new FatalAsrError(`HTTP ${res.status} ${body.slice(0, 200)}`)
      } catch (e) {
        if (e instanceof FatalAsrError) throw e
        lastErr = e
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async function archive(text: string) {
    try {
      const dir = archiveDir()
      await mkdir(dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      await appendFile(path.join(dir, `${day}.txt`), `[${time}] ${text}\n`, 'utf8')
    } catch (e) {
      log('warn', `archive failed: ${e}`)
    }
  }

  function handleSegment(wav: Buffer, startTs: number, endTs: number) {
    const dur = ((endTs - startTs) / 1000).toFixed(1)
    log('info', `segment received: ${dur}s / ${wav.length} bytes -> ASR`)
    asrChain = asrChain.then(async () => {
      broadcast({ type: 'asr', state: 'start' })
      try {
        const text = await transcribe(wav)
        if (text) {
          log('info', `ASR ok (${text.length} chars): ${text.slice(0, 60)}`)
          broadcast({ type: 'transcript', text, startTs, endTs, at: Date.now() })
          void archive(text)
        } else {
          log('warn', 'ASR returned empty text (no speech in segment?)')
          broadcast({ type: 'asr-empty', at: Date.now() })
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        lastError = message
        log('error', `ASR failed: ${message}`)
        broadcast({ type: 'error', message })
      } finally {
        broadcast({ type: 'asr', state: 'end' })
      }
    })
  }

  // ---- HTTP plumbing ------------------------------------------------------------
  function readJson(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const disposers: Array<() => void> = []

  disposers.push(
    ctx.webServer.register({ kind: 'exact', path: `${PREFIX}/events`, handler: handleEvents }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/status`,
      handler: (_req, res) =>
        json(res, 200, { running: !!helper, model: model(), baseUrl: baseUrl(), hasKey: !!apiKey(), python: python(), lastError }),
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/start`,
      handler: async (req, res) => {
        const r = startHelper()
        json(res, r.ok ? 200 : 500, r)
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/stop`,
      handler: (_req, res) => {
        stopHelper()
        json(res, 200, { ok: true })
      },
    }),
  )

  // Called by the local Python helper only; the token keeps other loopback
  // pages from injecting fake transcripts.
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/segment`,
      handler: async (req, res) => {
        try {
          const auth = String(req.headers['x-s2t-token'] ?? '')
          const expect = Buffer.from(helperToken)
          const got = Buffer.from(auth)
          if (!helperToken || expect.length !== got.length || !timingSafeEqual(expect, got)) {
            json(res, 403, { ok: false, message: 'bad token' })
            return
          }
          const body = await readJson(req)
          const wav = Buffer.from(String(body.wavB64 ?? ''), 'base64')
          if (!wav.length) {
            json(res, 400, { ok: false, message: 'empty wav' })
            return
          }
          handleSegment(wav, Number(body.startTs ?? 0), Number(body.endTs ?? 0))
          json(res, 200, { ok: true })
        } catch (e) {
          json(res, 400, { ok: false, message: e instanceof Error ? e.message : String(e) })
        }
      },
    }),
  )

  heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n')
  }, 15_000)

  ctx.effect(() => () => {
    stopHelper()
    if (heartbeat) clearInterval(heartbeat)
    for (const res of sseClients) {
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
    sseClients.clear()
    for (const dispose of disposers) dispose()
  })

  log('info', `routes ready under ${PREFIX} (model=${model()}, baseUrl=${baseUrl()}, key=${apiKey() ? 'set' : 'MISSING'})`)
}
