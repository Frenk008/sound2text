// src/host/index.ts
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var name = "dsh-sound2text";
var inject = ["webServer"];
var PREFIX = "/api/sound2text";
var FatalAsrError = class extends Error {
};
var pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function apply(ctx, rawConfig = {}) {
  const cfg = rawConfig;
  const log = (level, msg) => {
    const line = `[sound2text] ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  const baseUrl = () => (cfg.baseUrl ?? process.env.S2T_BASE_URL ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
  const model = () => cfg.model ?? process.env.S2T_MODEL ?? "FunAudioLLM/SenseVoiceSmall";
  const language = () => cfg.language ?? process.env.S2T_LANGUAGE ?? "";
  const apiKey = () => cfg.apiKey ?? process.env.S2T_API_KEY ?? "";
  const python = () => cfg.python ?? process.env.S2T_PYTHON ?? "python";
  const archiveDir = () => cfg.archiveDir ?? process.env.S2T_ARCHIVE_DIR ?? path.join(homedir(), ".dsh", "sound2text", "transcripts");
  const asrMode = () => (cfg.asrMode ?? process.env.S2T_ASR_MODE ?? "batch").toLowerCase() === "stream" ? "stream" : "batch";
  const streamApiKey = () => cfg.streamApiKey ?? process.env.S2T_STREAM_API_KEY ?? "";
  const streamWorkspaceId = () => cfg.streamWorkspaceId ?? process.env.S2T_STREAM_WORKSPACE_ID ?? "";
  const streamUrl = () => cfg.streamUrl ?? process.env.S2T_STREAM_URL ?? (streamWorkspaceId() ? `wss://${streamWorkspaceId()}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` : "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  const streamModel = () => cfg.streamModel ?? process.env.S2T_STREAM_MODEL ?? "paraformer-realtime-v2";
  const streamLanguage = () => cfg.streamLanguage ?? process.env.S2T_STREAM_LANGUAGE ?? "";
  const activeModel = () => asrMode() === "stream" ? streamModel() : model();
  const activeHasKey = () => asrMode() === "stream" ? !!streamApiKey() : !!apiKey();
  let helper;
  let helperToken = "";
  let lastError = "";
  const sseClients = /* @__PURE__ */ new Set();
  let heartbeat;
  let asrChain = Promise.resolve();
  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}

`;
    for (const res of sseClients) res.write(frame);
  }
  function handleEvents(_req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify({ type: "status", running: !!helper, mode: asrMode(), hasKey: activeHasKey(), model: activeModel(), lastError })}

`);
    sseClients.add(res);
    res.on("close", () => sseClients.delete(res));
  }
  function startHelper() {
    if (helper) return { ok: true, message: "already running" };
    const port = ctx.webServer?.port;
    if (!port) return { ok: false, message: "web server port unknown" };
    helperToken = cfg.devToken ?? process.env.S2T_DEV_TOKEN ?? randomBytes(16).toString("hex");
    const helperDir = path.join(pkgRoot, "helper");
    const device = cfg.device ?? process.env.S2T_DEVICE ?? "";
    const helperArgs = [path.join(helperDir, "main.py"), "--port", String(port), "--token", helperToken];
    if (device) helperArgs.push("--device", device);
    if (asrMode() === "stream") {
      if (!streamApiKey()) {
        const message = "\u6D41\u5F0F\u6A21\u5F0F\u7F3A\u5C11\u914D\u7F6E\uFF1A\u9700\u8981 S2T_STREAM_API_KEY\uFF08\u963F\u91CC\u4E91\u767E\u70BC\u63A7\u5236\u53F0\u83B7\u53D6\uFF0C\u8BE6\u89C1 README\uFF09";
        lastError = message;
        broadcast({ type: "error", message });
        return { ok: false, message };
      }
      helperArgs.push("--asr-mode", "stream");
    }
    const env = { ...process.env };
    const passThrough = [
      ["S2T_STREAM_API_KEY", streamApiKey()],
      ["S2T_STREAM_URL", streamUrl()],
      ["S2T_STREAM_MODEL", streamModel()],
      ["S2T_STREAM_LANGUAGE", streamLanguage()]
    ];
    for (const [k, v] of passThrough) if (v) env[k] = v;
    try {
      helper = spawn(python(), helperArgs, {
        cwd: helperDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (e) {
      helper = void 0;
      const message = `\u65E0\u6CD5\u542F\u52A8 Python \u52A9\u624B (${python()}): ${e}`;
      lastError = message;
      broadcast({ type: "error", message });
      return { ok: false, message };
    }
    helper.stdout?.on("data", (d) => log("info", d.toString().trimEnd()));
    helper.stderr?.on("data", (d) => log("warn", d.toString().trimEnd()));
    helper.on("error", (e) => {
      lastError = `Python \u52A9\u624B\u542F\u52A8\u5931\u8D25: ${e.message}\uFF08\u68C0\u67E5 config.python / S2T_PYTHON\uFF09`;
      log("error", lastError);
      broadcast({ type: "error", message: lastError });
      helper = void 0;
      broadcast({ type: "status", running: false, mode: asrMode(), hasKey: activeHasKey(), model: activeModel(), lastError });
    });
    helper.on("exit", (code) => {
      const wasRunning = !!helper;
      helper = void 0;
      if (wasRunning) {
        log("info", `helper exited (${code})`);
        broadcast({ type: "status", running: false, mode: asrMode(), hasKey: activeHasKey(), model: activeModel(), lastError });
      }
    });
    log("info", `helper started: ${python()} (port ${port})`);
    broadcast({ type: "status", running: true, mode: asrMode(), hasKey: activeHasKey(), model: activeModel(), lastError });
    return { ok: true, message: "started" };
  }
  function stopHelper() {
    if (!helper) return;
    const proc = helper;
    helper = void 0;
    try {
      proc.kill();
    } catch {
    }
    broadcast({ type: "status", running: false, mode: asrMode(), hasKey: activeHasKey(), model: activeModel(), lastError });
  }
  async function transcribe(wav) {
    const key = apiKey();
    if (!key) throw new FatalAsrError("\u672A\u914D\u7F6E\u8BED\u97F3\u8BC6\u522B API Key\uFF08\u73AF\u5883\u53D8\u91CF S2T_API_KEY \u6216\u63D2\u4EF6 config.apiKey\uFF09");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    form.append("model", model());
    if (language()) form.append("language", language());
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${baseUrl()}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(6e4)
        });
        if (res.ok) {
          const j = await res.json();
          return (j.text ?? "").trim();
        }
        const body = await res.text();
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
        throw new FatalAsrError(`HTTP ${res.status} ${body.slice(0, 200)}`);
      } catch (e) {
        if (e instanceof FatalAsrError) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1e3 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  async function archive(text) {
    try {
      const dir = archiveDir();
      await mkdir(dir, { recursive: true });
      const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const time = (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
      await appendFile(path.join(dir, `${day}.txt`), `[${time}] ${text}
`, "utf8");
    } catch (e) {
      log("warn", `archive failed: ${e}`);
    }
  }
  function handleSegment(wav, startTs, endTs) {
    const dur = ((endTs - startTs) / 1e3).toFixed(1);
    log("info", `segment received: ${dur}s / ${wav.length} bytes -> ASR`);
    asrChain = asrChain.then(async () => {
      broadcast({ type: "asr", state: "start" });
      try {
        const text = await transcribe(wav);
        if (text) {
          log("info", `ASR ok (${text.length} chars): ${text.slice(0, 60)}`);
          broadcast({ type: "transcript", text, startTs, endTs, at: Date.now() });
          void archive(text);
        } else {
          log("warn", "ASR returned empty text (no speech in segment?)");
          broadcast({ type: "asr-empty", at: Date.now() });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        lastError = message;
        log("error", `ASR failed: ${message}`);
        broadcast({ type: "error", message });
      } finally {
        broadcast({ type: "asr", state: "end" });
      }
    });
  }
  function readJson(req, limit = 20 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const disposers = [];
  disposers.push(
    ctx.webServer.register({ kind: "exact", path: `${PREFIX}/events`, handler: handleEvents })
  );
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: `${PREFIX}/status`,
      handler: (_req, res) => json(res, 200, { running: !!helper, mode: asrMode(), model: activeModel(), baseUrl: baseUrl(), hasKey: activeHasKey(), python: python(), device: cfg.device ?? process.env.S2T_DEVICE ?? "(default output)", lastError })
    })
  );
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: `${PREFIX}/start`,
      handler: async (req, res) => {
        const r = startHelper();
        json(res, r.ok ? 200 : 500, r);
      }
    })
  );
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: `${PREFIX}/stop`,
      handler: (_req, res) => {
        stopHelper();
        json(res, 200, { ok: true });
      }
    })
  );
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: `${PREFIX}/segment`,
      handler: async (req, res) => {
        try {
          const auth = String(req.headers["x-s2t-token"] ?? "");
          const expect = Buffer.from(helperToken);
          const got = Buffer.from(auth);
          if (!helperToken || expect.length !== got.length || !timingSafeEqual(expect, got)) {
            json(res, 403, { ok: false, message: "bad token" });
            return;
          }
          const body = await readJson(req);
          const wav = Buffer.from(String(body.wavB64 ?? ""), "base64");
          if (!wav.length) {
            json(res, 400, { ok: false, message: "empty wav" });
            return;
          }
          handleSegment(wav, Number(body.startTs ?? 0), Number(body.endTs ?? 0));
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 400, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }
    })
  );
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: `${PREFIX}/stream/text`,
      handler: async (req, res) => {
        try {
          const auth = String(req.headers["x-s2t-token"] ?? "");
          const expect = Buffer.from(helperToken);
          const got = Buffer.from(auth);
          if (!helperToken || expect.length !== got.length || !timingSafeEqual(expect, got)) {
            json(res, 403, { ok: false, message: "bad token" });
            return;
          }
          const body = await readJson(req, 64 * 1024);
          const text = String(body.text ?? "").trim();
          if (text) {
            const startTs = Number(body.startTs ?? 0);
            const endTs = Number(body.endTs ?? 0);
            if (body.final) {
              log("info", `stream sentence: ${text.slice(0, 60)}`);
              broadcast({ type: "asr-final", text, startTs, endTs, at: Date.now() });
              void archive(text);
            } else {
              broadcast({ type: "asr-partial", text, startTs, endTs, at: Date.now() });
            }
          }
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 400, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }
    })
  );
  heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(": ping\n\n");
  }, 15e3);
  ctx.effect(() => () => {
    stopHelper();
    if (heartbeat) clearInterval(heartbeat);
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
      }
    }
    sseClients.clear();
    for (const dispose of disposers) dispose();
  });
  log("info", `routes ready under ${PREFIX} (mode=${asrMode()}, model=${activeModel()}, key=${activeHasKey() ? "set" : "MISSING"})`);
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
