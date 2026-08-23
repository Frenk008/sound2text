# dsh-sound2text — DeepSeek Harness 实时系统声音字幕插件

把电脑正在播放的声音（视频、直播、会议）实时转成文字，显示在 DSH Web UI 右侧的悬浮面板里；划选任意字幕文字，即可直接向 DeepSeek 提问，回答流式出现在当前会话。

```
系统声音 (WASAPI loopback)
   │  Python 助手（由 host 按需拉起）：48k→16k 重采样 + silero-vad 断句
   ▼
host 插件（随 dsh web 运行）
   │  调用 OpenAI 兼容语音识别 API（默认硅基流动）+ 按天归档
   ▼ SSE (/api/sound2text/events)
浏览器面板：实时滚动字幕
   └─ 划选文字 → 输入问题 → session.prompt() → 回答进入当前会话
```

## 前置条件

- Windows 10/11（采集依赖 WASAPI loopback）
- Node.js 20+（本机已装 24）
- dsh CLI：`npm i -g @deepseek-ai/dsh`
- Python 3.10+ 且已装依赖：`pip install -r helper/requirements.txt`（本机 miniforge3 已装）
- 一个语音识别 API Key（默认服务为[硅基流动](https://siliconflow.cn)，SenseVoice/Fun-ASR 有免费额度）

## 安装（本机已完成）

```bat
install.bat
```

它做三件事：全局装 dsh/pnpm（若缺）、把本目录装入 web profile（`dsh plugin --profile web add`）、
向 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加组合行。本机额外配置了 `python` 路径指向 miniforge3。

## 配置

环境变量（也可写在 profile 的 cordis.patch.yml 里 sound2text 行的 `config` 下）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `S2T_API_KEY` | 无（必填） | 语音识别服务的 API Key |
| `S2T_BASE_URL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容 base URL |
| `S2T_MODEL` | `FunAudioLLM/SenseVoiceSmall` | 模型 id（硅基流动已验证；OpenAI 用 `whisper-1`） |
| `S2T_LANGUAGE` | 空 | 语言提示，用 OpenAI whisper-1 时建议 `zh`（SenseVoice 留空） |
| `S2T_PYTHON` | `python` | Python 解释器路径 |
| `S2T_DEVICE` | 系统默认输出设备 | 采集哪个输出设备（必须是**声音实际播放的设备**）。`python helper/main.py --list-devices` 查看名称 |
| `S2T_ARCHIVE_DIR` | `~/.dsh/sound2text/transcripts` | 字幕按天归档目录 |

改代码后：`npm run build`（profile 是 link 安装，产物即时生效）。

## 使用

1. 在**你自己的终端**（不要在服务/远程/沙箱会话里，否则没有音频设备访问权）：
   ```bat
   set S2T_API_KEY=sk-你的key
   dsh web
   ```
2. 浏览器打开 http://127.0.0.1:3080 ，右侧出现「实时字幕」面板
3. 点「开始监听」→ 播放任意视频/直播，句末 1~3 秒内字幕上屏
4. 划选字幕中的文字 → 底部弹出引用栏 → 输入问题回车 → 回答出现在当前会话

面板可拖左边缘调宽窄、点「»」收成右侧竖条、点竖条展开；宽度与收起状态会记住。

## 常见问题

- **点开始后立即停止 / 提示无法访问音频设备**：dsh 运行在没有音频会话的环境（SSH/服务/某些终端）。在与扬声器同一登录会话的普通终端启动 `dsh web`。
- **采不到某个播放源**：采集的是「默认输出设备」的回声。`python helper/main.py --list-devices` 查看设备，用 `--device "设备名"` 指定（写进 host spawn 参数需改 host/index.ts）。
- **想用麦克风而不是系统声音**：helper 里 `include_loopback=True` 改为 False 并选麦克风设备。
- **识别服务换成别家**：任何 OpenAI 兼容 `/audio/transcriptions` 都可以，改 `S2T_BASE_URL` / `S2T_MODEL` / `S2T_API_KEY` 即可。
- **首次「开始监听」**：会自动下载 silero-vad 模型（约 2.3MB，已缓存在 `helper/models/`）。

## 架构说明（对着 DSH 0.1.0-rc.7/8 写的）

- **host 半**（`src/host/index.ts`）：Cordis 插件，`inject: ['webServer']`，在 `ctx.webServer` 注册
  `/api/sound2text/{events,status,start,stop,segment}` 五个路由；`segment` 由本地 Python 助手带
  一次性 token 上传（timingSafeEqual 校验）；ASR 失败重试 2 次（429/5xx），4xx 直接报错。
- **client 半**（`src/client/`）：`dsh.client` 包，esbuild 产出官方 closure-factory 格式
  （`window.__ModuleLoader__.load({id, factory})`），运行时仅依赖平台表内的 react 系。
  面板走 portal 到 body 的固定定位层——DSH 的 `details`/`sidebar` slot 是 single-kind 且已被内置
  UI 占用（二次注册会抛错），浮动面板是零冲突的扩展位。
- **划选提问**：`ctx.sessions.list.getSnapshot().current` → `ctx.sessions.scope()` →
  `session.prompt([{type:'text',text}], 'queue')`，回答以流式 chunk 回到主聊天区。
- **VAD**：silero-vad v5 onnx（`onnxruntime` CPU 单线程），512 样本窗 + 64 右上下文，
  起始阈值 0.60 / 保持 0.45，静音 0.7s 断句、10s 强切、0.35s 以下丢弃。

## 已知限制

- 面板刷新后历史字幕清空（SSE 无回放；归档文件里有全量）
- 助手固定采集默认扬声器；多输出设备切换需改 `--device`
- 依赖 DSH 开发者预览版 API（`webServer` 服务名在 rc.8 由 `httpServer` 改名而来）；升级 dsh 若再改名，改 `src/host/index.ts` 里的 `inject` 与 `ctx.webServer` 即可
