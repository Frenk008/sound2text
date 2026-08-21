import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from '../types.ts'

interface Entry {
  at: number
  startTs: number
  endTs: number
  text: string
}

interface StatusEvent {
  running: boolean
  hasKey: boolean
  model: string
  lastError: string
}

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function Sound2TextPanel({ ctx }: { ctx: ClientContext }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<StatusEvent>({ running: false, hasKey: false, model: '', lastError: '' })
  const [asrBusy, setAsrBusy] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('s2t.collapsed') === '1')
  const [width, setWidth] = useState(() => clamp(Number(localStorage.getItem('s2t.width')) || 360, 280, 640))
  const [selection, setSelection] = useState('')
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState('')

  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  useEffect(() => {
    const es = new EventSource('/api/sound2text/events')
    es.onmessage = (ev: MessageEvent<string>) => {
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'status':
          setStatus({ running: !!msg.running, hasKey: !!msg.hasKey, model: msg.model ?? '', lastError: msg.lastError ?? '' })
          break
        case 'transcript':
          setEntries((prev) => {
            const next = prev.concat({ at: msg.at ?? Date.now(), startTs: msg.startTs, endTs: msg.endTs, text: String(msg.text) })
            return next.length > 500 ? next.slice(next.length - 500) : next
          })
          setError('')
          break
        case 'asr':
          setAsrBusy(msg.state === 'start')
          break
        case 'error':
          setError(String(msg.message ?? '未知错误'))
          break
      }
    }
    es.onerror = () => setError('与本地服务的连接中断，正在自动重连…')
    es.onopen = () => setError('')
    return () => es.close()
  }, [])

  useEffect(() => {
    if (listRef.current && stickBottom.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [entries, asrBusy])

  const toggle = useCallback(async () => {
    try {
      if (status.running) {
        await fetch('/api/sound2text/stop', { method: 'POST' })
      } else {
        setError('')
        const r = await fetch('/api/sound2text/start', { method: 'POST' })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}) as any)
          setError(j.message ?? '启动失败')
        }
      }
    } catch (e) {
      setError(`请求失败: ${e}`)
    }
  }, [status.running])

  const onPointerUp = useCallback(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (text && sel && listRef.current && listRef.current.contains(sel.anchorNode)) {
      setSelection(text)
      setFeedback('')
    } else if (!text) {
      setSelection('')
    }
  }, [])

  const ask = useCallback(async () => {
    const q = question.trim()
    if (!q || !selection || sending) return
    setSending(true)
    setFeedback('')
    try {
      const current = ctx.sessions.list.getSnapshot().current
      if (!current) {
        setFeedback('没有当前会话：请先在左侧选择或新建一个会话')
        return
      }
      const scoped = ctx.sessions.scope(current)
      const session = scoped ? ctx.sessions.sessionOf(scoped) : undefined
      if (!session) {
        setFeedback('无法连接到当前会话')
        return
      }
      const message = `【实时字幕提问】\n\n字幕选段：\n「${selection}」\n\n我的问题：${q}`
      await session.prompt([{ type: 'text', text: message }], 'queue')
      setFeedback('已发送，回答见当前会话 ✅')
      setQuestion('')
      setSelection('')
    } catch (e) {
      setFeedback(`发送失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSending(false)
    }
  }, [ctx, question, selection, sending])

  const startResize = useCallback(
    (down: React.PointerEvent) => {
      down.preventDefault()
      const startX = down.clientX
      const startWidth = width
      const move = (e: PointerEvent) => {
        const w = clamp(startWidth + (startX - e.clientX), 280, 640)
        setWidth(w)
        localStorage.setItem('s2t.width', String(w))
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [width],
  )

  const collapse = (v: boolean) => {
    setCollapsed(v)
    localStorage.setItem('s2t.collapsed', v ? '1' : '0')
  }

  if (collapsed) {
    return (
      <button className="s2t-tab" title="展开实时字幕面板" onClick={() => collapse(false)}>
        实时字幕{status.running ? '●' : ''}
      </button>
    )
  }

  return (
    <div className="s2t-panel" style={{ width }}>
      <div className="s2t-resize" onPointerDown={startResize} />
      <header className="s2t-head">
        <span className={`s2t-dot${status.running ? ' on' : ''}`} />
        <span className="s2t-title">实时字幕</span>
        {asrBusy && <span className="s2t-busy">识别中…</span>}
        <span className="s2t-spacer" />
        <button className="s2t-btn primary" onClick={toggle} title={status.model ? `模型：${status.model}` : undefined}>
          {status.running ? '停止' : '开始监听'}
        </button>
        <button className="s2t-btn" onClick={() => setEntries([])} title="清空字幕">
          清空
        </button>
        <button className="s2t-btn" onClick={() => collapse(true)} title="收起到侧边">
          »
        </button>
      </header>

      {!status.hasKey && (
        <div className="s2t-note">未配置识别服务 API Key：设置环境变量 S2T_API_KEY 后重启 dsh（详见插件 README）</div>
      )}
      {error && <div className="s2t-note err">{error}</div>}

      <div
        ref={listRef}
        className="s2t-list"
        onPointerUp={onPointerUp}
        onScroll={() => {
          const el = listRef.current
          if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {entries.length === 0 && !asrBusy && (
          <div className="s2t-empty">
            点击「开始监听」，然后播放任意视频、直播或会议音频，字幕会实时出现在这里。
            <br />
            划选任意文字，可直接就这段内容向 DeepSeek 提问。
          </div>
        )}
        {entries.map((e, i) => (
          <div className="s2t-item" key={i}>
            <span className="s2t-time">{fmtTime(e.at)}</span>
            <span className="s2t-text">{e.text}</span>
          </div>
        ))}
        {asrBusy && <div className="s2t-item pending">…</div>}
      </div>

      {selection && (
        <div className="s2t-ask">
          <div className="s2t-quote">
            <span>「{selection.length > 72 ? `${selection.slice(0, 72)}…` : selection}」</span>
            <button className="s2t-x" onClick={() => setSelection('')} title="取消选段">
              ×
            </button>
          </div>
          <div className="s2t-row">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void ask()
              }}
              placeholder="就这段字幕向 DeepSeek 提问…"
              autoFocus
            />
            <button className="s2t-btn primary" disabled={!question.trim() || sending} onClick={() => void ask()}>
              {sending ? '发送中' : '提问'}
            </button>
          </div>
          {feedback && <div className="s2t-feedback">{feedback}</div>}
        </div>
      )}
    </div>
  )
}

export const css = `
.s2t-panel{position:fixed;top:12px;right:12px;bottom:12px;z-index:5000;display:flex;flex-direction:column;
  background:rgba(32,33,36,.94);color:#e8eaed;border:1px solid rgba(255,255,255,.14);border-radius:12px;
  backdrop-filter:blur(8px);box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden;font-size:13px;user-select:none}
.s2t-resize{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2}
.s2t-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);flex:none}
.s2t-dot{width:8px;height:8px;border-radius:50%;background:#9aa0a6;flex:none}
.s2t-dot.on{background:#34a853;box-shadow:0 0 6px #34a853}
.s2t-title{font-weight:600}
.s2t-busy{color:#8ab4f8;font-size:12px}
.s2t-spacer{flex:1}
.s2t-btn{background:rgba(255,255,255,.08);color:#e8eaed;border:1px solid rgba(255,255,255,.16);border-radius:6px;
  padding:3px 10px;cursor:pointer;font-size:12px;flex:none}
.s2t-btn:hover{background:rgba(255,255,255,.16)}
.s2t-btn.primary{background:#1a73e8;border-color:#1a73e8}
.s2t-btn.primary:hover{background:#2b7de9}
.s2t-btn:disabled{opacity:.45;cursor:default}
.s2t-note{padding:6px 10px;background:rgba(252,214,10,.12);color:#fdd663;font-size:12px;flex:none}
.s2t-note.err{background:rgba(237,78,76,.15);color:#f28b82}
.s2t-list{flex:1;overflow-y:auto;padding:8px 12px;user-select:text;scrollbar-width:thin}
.s2t-empty{color:#9aa0a6;line-height:1.8;padding:24px 8px;text-align:center}
.s2t-item{display:flex;gap:8px;padding:4px 0;line-height:1.65}
.s2t-item.pending{color:#9aa0a6}
.s2t-time{color:#9aa0a6;font-size:11px;font-variant-numeric:tabular-nums;flex:none;padding-top:2px;user-select:none}
.s2t-text{white-space:pre-wrap;word-break:break-word}
.s2t-ask{border-top:1px solid rgba(255,255,255,.1);padding:8px 10px;background:rgba(26,115,232,.08);flex:none}
.s2t-quote{display:flex;gap:6px;align-items:flex-start;color:#8ab4f8;font-size:12px;margin-bottom:6px;line-height:1.5}
.s2t-quote span{flex:1;word-break:break-all}
.s2t-x{background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:14px;padding:0 2px}
.s2t-x:hover{color:#e8eaed}
.s2t-row{display:flex;gap:6px}
.s2t-row input{flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);color:#e8eaed;
  border-radius:6px;padding:5px 8px;font-size:12px;outline:none;min-width:0}
.s2t-row input:focus{border-color:#8ab4f8}
.s2t-feedback{color:#9aa0a6;font-size:11px;margin-top:4px}
.s2t-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:5000;writing-mode:vertical-rl;
  background:rgba(32,33,36,.92);color:#e8eaed;border:1px solid rgba(255,255,255,.18);border-right:none;
  border-radius:8px 0 0 8px;padding:12px 6px;cursor:pointer;font-size:13px;letter-spacing:2px}
.s2t-tab:hover{background:rgba(60,62,66,.95)}
`
