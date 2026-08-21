window.__ModuleLoader__.load({
	id: "dsh-sound2text",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react2 = require("react");
var import_client = require("react-dom/client");

// src/client/panel.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var fmtTime = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function Sound2TextPanel({ ctx }) {
  const [entries, setEntries] = (0, import_react.useState)([]);
  const [status, setStatus] = (0, import_react.useState)({ running: false, hasKey: false, model: "", lastError: "" });
  const [asrBusy, setAsrBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [collapsed, setCollapsed] = (0, import_react.useState)(() => localStorage.getItem("s2t.collapsed") === "1");
  const [width, setWidth] = (0, import_react.useState)(() => clamp(Number(localStorage.getItem("s2t.width")) || 360, 280, 640));
  const [selection, setSelection] = (0, import_react.useState)("");
  const [question, setQuestion] = (0, import_react.useState)("");
  const [sending, setSending] = (0, import_react.useState)(false);
  const [feedback, setFeedback] = (0, import_react.useState)("");
  const listRef = (0, import_react.useRef)(null);
  const stickBottom = (0, import_react.useRef)(true);
  (0, import_react.useEffect)(() => {
    const es = new EventSource("/api/sound2text/events");
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "status":
          setStatus({ running: !!msg.running, hasKey: !!msg.hasKey, model: msg.model ?? "", lastError: msg.lastError ?? "" });
          break;
        case "transcript":
          setEntries((prev) => {
            const next = prev.concat({ at: msg.at ?? Date.now(), startTs: msg.startTs, endTs: msg.endTs, text: String(msg.text) });
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
          setError("");
          break;
        case "asr":
          setAsrBusy(msg.state === "start");
          break;
        case "error":
          setError(String(msg.message ?? "\u672A\u77E5\u9519\u8BEF"));
          break;
      }
    };
    es.onerror = () => setError("\u4E0E\u672C\u5730\u670D\u52A1\u7684\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8FDE\u2026");
    es.onopen = () => setError("");
    return () => es.close();
  }, []);
  (0, import_react.useEffect)(() => {
    if (listRef.current && stickBottom.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [entries, asrBusy]);
  const toggle = (0, import_react.useCallback)(async () => {
    try {
      if (status.running) {
        await fetch("/api/sound2text/stop", { method: "POST" });
      } else {
        setError("");
        const r = await fetch("/api/sound2text/start", { method: "POST" });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.message ?? "\u542F\u52A8\u5931\u8D25");
        }
      }
    } catch (e) {
      setError(`\u8BF7\u6C42\u5931\u8D25: ${e}`);
    }
  }, [status.running]);
  const onPointerUp = (0, import_react.useCallback)(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (text && sel && listRef.current && listRef.current.contains(sel.anchorNode)) {
      setSelection(text);
      setFeedback("");
    } else if (!text) {
      setSelection("");
    }
  }, []);
  const ask = (0, import_react.useCallback)(async () => {
    const q = question.trim();
    if (!q || !selection || sending) return;
    setSending(true);
    setFeedback("");
    try {
      const current = ctx.sessions.list.getSnapshot().current;
      if (!current) {
        setFeedback("\u6CA1\u6709\u5F53\u524D\u4F1A\u8BDD\uFF1A\u8BF7\u5148\u5728\u5DE6\u4FA7\u9009\u62E9\u6216\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD");
        return;
      }
      const scoped = ctx.sessions.scope(current);
      const session = scoped ? ctx.sessions.sessionOf(scoped) : void 0;
      if (!session) {
        setFeedback("\u65E0\u6CD5\u8FDE\u63A5\u5230\u5F53\u524D\u4F1A\u8BDD");
        return;
      }
      const message = `\u3010\u5B9E\u65F6\u5B57\u5E55\u63D0\u95EE\u3011

\u5B57\u5E55\u9009\u6BB5\uFF1A
\u300C${selection}\u300D

\u6211\u7684\u95EE\u9898\uFF1A${q}`;
      await session.prompt([{ type: "text", text: message }], "queue");
      setFeedback("\u5DF2\u53D1\u9001\uFF0C\u56DE\u7B54\u89C1\u5F53\u524D\u4F1A\u8BDD \u2705");
      setQuestion("");
      setSelection("");
    } catch (e) {
      setFeedback(`\u53D1\u9001\u5931\u8D25: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  }, [ctx, question, selection, sending]);
  const startResize = (0, import_react.useCallback)(
    (down) => {
      down.preventDefault();
      const startX = down.clientX;
      const startWidth = width;
      const move = (e) => {
        const w = clamp(startWidth + (startX - e.clientX), 280, 640);
        setWidth(w);
        localStorage.setItem("s2t.width", String(w));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [width]
  );
  const collapse = (v) => {
    setCollapsed(v);
    localStorage.setItem("s2t.collapsed", v ? "1" : "0");
  };
  if (collapsed) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { className: "s2t-tab", title: "\u5C55\u5F00\u5B9E\u65F6\u5B57\u5E55\u9762\u677F", onClick: () => collapse(false), children: [
      "\u5B9E\u65F6\u5B57\u5E55",
      status.running ? "\u25CF" : ""
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "s2t-panel", style: { width }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "s2t-resize", onPointerDown: startResize }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "s2t-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `s2t-dot${status.running ? " on" : ""}` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "s2t-title", children: "\u5B9E\u65F6\u5B57\u5E55" }),
      asrBusy && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "s2t-busy", children: "\u8BC6\u522B\u4E2D\u2026" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "s2t-spacer" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "s2t-btn primary", onClick: toggle, title: status.model ? `\u6A21\u578B\uFF1A${status.model}` : void 0, children: status.running ? "\u505C\u6B62" : "\u5F00\u59CB\u76D1\u542C" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "s2t-btn", onClick: () => setEntries([]), title: "\u6E05\u7A7A\u5B57\u5E55", children: "\u6E05\u7A7A" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "s2t-btn", onClick: () => collapse(true), title: "\u6536\u8D77\u5230\u4FA7\u8FB9", children: "\xBB" })
    ] }),
    !status.hasKey && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "s2t-note", children: "\u672A\u914D\u7F6E\u8BC6\u522B\u670D\u52A1 API Key\uFF1A\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF S2T_API_KEY \u540E\u91CD\u542F dsh\uFF08\u8BE6\u89C1\u63D2\u4EF6 README\uFF09" }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "s2t-note err", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        ref: listRef,
        className: "s2t-list",
        onPointerUp,
        onScroll: () => {
          const el = listRef.current;
          if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        },
        children: [
          entries.length === 0 && !asrBusy && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "s2t-empty", children: [
            "\u70B9\u51FB\u300C\u5F00\u59CB\u76D1\u542C\u300D\uFF0C\u7136\u540E\u64AD\u653E\u4EFB\u610F\u89C6\u9891\u3001\u76F4\u64AD\u6216\u4F1A\u8BAE\u97F3\u9891\uFF0C\u5B57\u5E55\u4F1A\u5B9E\u65F6\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
            "\u5212\u9009\u4EFB\u610F\u6587\u5B57\uFF0C\u53EF\u76F4\u63A5\u5C31\u8FD9\u6BB5\u5185\u5BB9\u5411 DeepSeek \u63D0\u95EE\u3002"
          ] }),
          entries.map((e, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "s2t-item", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "s2t-time", children: fmtTime(e.at) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "s2t-text", children: e.text })
          ] }, i)),
          asrBusy && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "s2t-item pending", children: "\u2026" })
        ]
      }
    ),
    selection && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "s2t-ask", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "s2t-quote", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          "\u300C",
          selection.length > 72 ? `${selection.slice(0, 72)}\u2026` : selection,
          "\u300D"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "s2t-x", onClick: () => setSelection(""), title: "\u53D6\u6D88\u9009\u6BB5", children: "\xD7" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "s2t-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            value: question,
            onChange: (e) => setQuestion(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void ask();
            },
            placeholder: "\u5C31\u8FD9\u6BB5\u5B57\u5E55\u5411 DeepSeek \u63D0\u95EE\u2026",
            autoFocus: true
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "s2t-btn primary", disabled: !question.trim() || sending, onClick: () => void ask(), children: sending ? "\u53D1\u9001\u4E2D" : "\u63D0\u95EE" })
      ] }),
      feedback && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "s2t-feedback", children: feedback })
    ] })
  ] });
}
var css = `
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
`;

// src/client/index.tsx
var inject = ["sessions"];
function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const host = document.createElement("div");
    host.dataset.s2tRoot = "";
    document.body.append(host);
    const root = (0, import_client.createRoot)(host);
    root.render((0, import_react2.createElement)(Sound2TextPanel, { ctx }));
    return () => {
      root.unmount();
      host.remove();
      style.remove();
    };
  });
}
return module.exports;
	}
});
//# sourceMappingURL=client.js.map
