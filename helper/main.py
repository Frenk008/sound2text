# -*- coding: utf-8 -*-
"""
dsh-sound2text capture helper.

Captures whatever Windows is playing (WASAPI loopback of the default speaker),
resamples to 16 kHz mono, runs silero-vad to cut complete utterances, and POSTs
each segment as base64 WAV to the dsh-sound2text host plugin:

    POST http://127.0.0.1:<port>/api/sound2text/segment
         {"startTs": ms, "endTs": ms, "wavB64": "..."}
         header: x-s2t-token: <token>

The host kills this process to stop capture; dying when the parent disappears
is fine. Run standalone with --dry-run to test capture/VAD without a host.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import sys
import time
import urllib.request
import wave
from fractions import Fraction
from pathlib import Path

import numpy as np

HELPER_VERSION = "2026-08-23g"

TARGET_RATE = 16000
FRAME_SEC = 0.032                     # 32 ms VAD frame
# VAD state machine tuning
START_PROB = 0.60                     # probability to enter speech
END_PROB = 0.45                       # probability to stay in speech
SILENCE_EXIT_SEC = 0.7                # trailing silence that closes a segment
MAX_SEGMENT_SEC = 3.0                 # force-cut long continuous speech
MIN_SEGMENT_SEC = 0.35                # discard blips
MODEL_URLS = [
    "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
    "https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx",
]


def log(msg: str) -> None:
    print(f"[helper] {msg}", flush=True)


# stdout/stderr may default to GBK when spawned by a Node host on Windows;
# force UTF-8 so the Chinese diagnostics survive the pipe.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")


def ensure_model(model_dir: Path) -> Path:
    model_path = model_dir / "silero_vad.onnx"
    if model_path.exists() and model_path.stat().st_size > 100_000:
        return model_path
    model_dir.mkdir(parents=True, exist_ok=True)

    last: Exception | None = None
    for url in MODEL_URLS:
        try:
            log(f"downloading silero-vad model from {url}")
            tmp = model_path.with_suffix(".onnx.part")
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(model_path)
            return model_path
        except Exception as e:  # noqa: BLE001
            last = e
            log(f"download failed: {e}")
    raise SystemExit(f"无法下载 silero-vad 模型（{last}）。请手动下载 silero_vad.onnx 放到 {model_path}")


class Vad:
    """silero-vad v5 ONNX streaming wrapper: fixed 512-sample windows @16 kHz."""

    def __init__(self, model_path: Path):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 3  # errors only: the graph-cleanup warnings are noise
        self.sess = ort.InferenceSession(str(model_path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self) -> None:
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.sr = np.array([TARGET_RATE], dtype=np.int64)
        self.ctx = np.zeros((1, 64), dtype=np.float32)  # v5 right-context buffer

    def prob(self, x: np.ndarray) -> float:
        """x: float32 [512] mono samples in [-1,1]. Returns speech probability."""
        window = np.concatenate([self.ctx, x[None, :]], axis=1)  # [1, 576]
        out, self.state = self.sess.run(
            None,
            {"input": window, "state": self.state, "sr": self.sr},
        )[:2]
        self.ctx = x[-64:][None, :]
        return float(out[0][0])


class Segmenter:
    """Accumulates speech between VAD decisions and emits complete segments.

    feed() gets called once per 32 ms frame with that frame's speech
    probability and returns (int16-ready float audio, start_wallclock_ms)
    when a complete utterance closed, else None.
    """

    def __init__(self) -> None:
        self.clear()
        # Rolling out-of-speech frame RMS history -> adaptive noise floor.
        # Survives clear() on purpose: one estimate for the whole session.
        self._noise: list[float] = []

    def clear(self) -> None:
        self.buf: list[np.ndarray] = []   # short pre-roll ring, always fed
        self.in_speech = False
        self.silence_run = 0.0
        self.speech_run = 0.0
        self.seg: list[np.ndarray] = []
        self.seg_start: float | None = None

    def _track_noise(self, frame_rms: float) -> None:
        """Out-of-speech frames feed the rolling noise-floor estimate."""
        self._noise.append(frame_rms)
        if len(self._noise) > 150:
            del self._noise[:75]

    def _noise_gate(self) -> float:
        """Speech entry needs RMS clearly above the session noise floor, so a
        quiet-but-real voice passes while an unused device's idle noise
        (constant RMS) never looks like speech."""
        floor = sorted(self._noise)[len(self._noise) // 2] if self._noise else 0.0
        return max(3.0 * floor, 0.004)

    def feed(self, frame: np.ndarray, p: float, now_ms: float) -> tuple[np.ndarray, float, float] | None:
        self.buf.append(frame)
        if len(self.buf) > 3:
            del self.buf[: -3]

        if not self.in_speech:
            frame_rms = float(np.sqrt(np.mean(np.square(frame))))
            warmed_up = len(self._noise) >= 30  # ~1 s of floor data before arming
            self._track_noise(frame_rms)
            if warmed_up and p >= START_PROB and frame_rms >= self._noise_gate():
                self.in_speech = True
                self.speech_run = 0.0
                self.silence_run = 0.0
                self.seg_start = now_ms - len(self.buf) * FRAME_SEC * 1000
                self.seg = list(self.buf)  # pre-roll includes the trigger frame
            return None

        self.speech_run += FRAME_SEC
        self.seg.append(frame)
        if p >= END_PROB:
            self.silence_run = 0.0
        else:
            self.silence_run += FRAME_SEC

        if self.silence_run < SILENCE_EXIT_SEC and self.speech_run < MAX_SEGMENT_SEC:
            return None

        seg, start = self.seg, self.seg_start
        self.clear()
        if not seg or start is None:
            return None
        audio = np.concatenate(seg)
        if len(audio) < int(MIN_SEGMENT_SEC * TARGET_RATE):
            return None
        # Loopback captures the POST-volume-mix signal: when Windows volume is
        # low (user compensates with monitor hardware volume) real speech
        # arrives far too quiet for the ASR — peak-normalize quiet segments.
        peak = float(np.max(np.abs(audio)))
        gain = 1.0
        if 1e-4 < peak < 0.25:
            gain = 0.5 / peak
            audio = audio * gain
        return np.clip(audio, -1.0, 1.0), start, gain


class StreamPump:
    """Stream-mode bridge: pushes 16k mono frames to the streaming ASR while
    the VAD gate says speech, and opens/closes metered tasks around utterances
    so idle silence is never sent (Paraformer bills pushed audio duration)."""

    IDLE_CLOSE_SEC = 15.0   # stop the task after this much silence
    PREROLL_FRAMES = 10     # ~320 ms kept before speech onset, anti-clipping

    def __init__(self, stream, post=None):
        self.stream = stream      # stream_asr.ParaformerStream
        self.post = post          # post(text, start_ms, end_ms, final)
        self._noise: list[float] = []
        self.speaking = False
        self.silence_run = 0.0
        self.idle_run = 0.0
        self.preroll: list[np.ndarray] = []
        self.gain = 1.0
        self._peak = 0.0
        stream.on_sentence = self._on_sentence

    def _push(self, frame: np.ndarray) -> None:
        self.idle_run = 0.0
        if not self.stream.task_open and not self.stream.start_task():
            return
        scaled = np.clip(frame * self.gain, -1.0, 1.0)
        if scaled.size:
            self._peak = max(self._peak, float(np.max(np.abs(scaled))))
        self.stream.feed((scaled * 32767.0).astype("<i2").tobytes())

    def _adapt_gain(self) -> None:
        """Between utterances: retarget so the next one peaks near 0.5 (loopback
        captures the POST-volume-mix signal, which can be very quiet)."""
        if 1e-4 < self._peak < 0.25:
            self.gain = min(0.5 / self._peak, 16.0)
        elif self._peak >= 0.25:
            self.gain = 1.0

    def _on_sentence(self, text: str, begin_ms, end_ms, final: bool) -> None:
        start = self.stream.wallclock(begin_ms)
        end = self.stream.wallclock(end_ms) if end_ms is not None else int(time.time() * 1000)
        log(f"{'final' if final else 'partial'}: {text}")
        if self.post:
            self.post(text, start, end, final)

    def handle(self, frame: np.ndarray, p: float) -> None:
        if not self.speaking:
            frame_rms = float(np.sqrt(np.mean(np.square(frame))))
            self.preroll.append(frame)
            if len(self.preroll) > self.PREROLL_FRAMES:
                del self.preroll[: -self.PREROLL_FRAMES]
            self._noise.append(frame_rms)
            if len(self._noise) > 150:
                del self._noise[:75]
            floor = sorted(self._noise)[len(self._noise) // 2] if self._noise else 0.0
            gate = max(3.0 * floor, 0.004)
            warmed = len(self._noise) >= 30  # ~1 s of floor data before arming
            if warmed and p >= START_PROB and frame_rms >= gate:
                self.speaking = True
                self.silence_run = 0.0
                self.idle_run = 0.0
                self._peak = 0.0
                for f in self.preroll:
                    self._push(f)
                self.preroll = []
                self._push(frame)
            else:
                self.idle_run += FRAME_SEC
                if self.stream.task_open and self.idle_run >= self.IDLE_CLOSE_SEC:
                    self.stream.stop_task()
            return

        self._push(frame)
        if p >= END_PROB:
            self.silence_run = 0.0
        else:
            self.silence_run += FRAME_SEC
        if self.silence_run >= SILENCE_EXIT_SEC:
            self.speaking = False
            self.silence_run = 0.0
            self.idle_run = 0.0
            self._adapt_gain()


def wav_bytes(pcm: np.ndarray) -> bytes:
    # segments arrive as float32 in [-1,1]; astype(int16) truncates them to
    # all-zero silence, so scale floats to the int16 range first
    if np.issubdtype(pcm.dtype, np.floating):
        pcm = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype(np.int16)
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(pcm.tobytes())
    return bio.getvalue()


def safe_write_wav(path: Path, audio: np.ndarray) -> None:
    """Debug dump that must never kill the capture pipeline — e.g. a player
    still holding the previous file open denies writes on Windows."""
    try:
        path.write_bytes(wav_bytes(audio))
    except OSError as e:
        log(f"debug wav write skipped ({e})")


def post_segment(url: str, token: str, start_ms: float, end_ms: float, wav: bytes) -> bool:
    body = json.dumps(
        {"startTs": round(start_ms), "endTs": round(end_ms), "wavB64": base64.b64encode(wav).decode("ascii")}
    ).encode("utf-8")
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={"content-type": "application/json", "x-s2t-token": token},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status == 200:
                    return True
                log(f"segment POST -> HTTP {resp.status}")
        except Exception as e:  # noqa: BLE001
            log(f"segment POST failed ({attempt + 1}/3): {e}")
            time.sleep(0.8 * (attempt + 1))
    return False


def post_stream_text(url: str, token: str, text: str, start_ms: float, end_ms: float, final: bool) -> None:
    """Fire-and-forget relay of a streaming sentence to the host."""
    body = json.dumps(
        {"text": text, "startTs": round(start_ms), "endTs": round(end_ms), "final": bool(final)}
    ).encode("utf-8")
    for attempt in range(2):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={"content-type": "application/json", "x-s2t-token": token},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    return
                log(f"stream text POST -> HTTP {resp.status}")
        except Exception as e:  # noqa: BLE001
            log(f"stream text POST failed ({attempt + 1}/2): {e}")
            time.sleep(0.3)


def pick_loopback(device_name: str | None):
    import soundcard as sc

    try:
        if device_name:
            return sc.get_microphone(device_name, include_loopback=True)
        speaker = sc.default_speaker()
        log(f"capturing system audio (loopback of {speaker.name})")
        return sc.get_microphone(str(speaker.name), include_loopback=True)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            f"无法访问音频输出设备（{e}）。\n"
            "常见原因：本程序运行在无音频会话的环境（服务/远程/沙箱终端）。\n"
            "请在与扬声器同一登录会话的正常终端里启动 dsh web。"
        )


def pyaudiowpatch_source(device_name: str | None):
    """Capture via pyaudiowpatch (dedicated WASAPI loopback support; handles
    HDMI/DP devices whose MediaFoundation loopback misbehaves). Yields
    (mono float32 block, exact device rate)."""
    import pyaudiowpatch as pyaudio

    with pyaudio.PyAudio() as p:
        loopbacks = list(p.get_loopback_device_info_generator())
        target = None
        if device_name:
            for lb in loopbacks:
                if device_name.lower() in lb["name"].lower():
                    target = lb
                    break
        else:
            default_out = p.get_default_output_device_info()
            for lb in loopbacks:
                if default_out["name"] in lb["name"]:
                    target = lb
                    break
            target = target or (loopbacks[0] if loopbacks else None)
        if target is None:
            raise RuntimeError("pyaudiowpatch found no loopback device")
        rate = int(target["defaultSampleRate"])
        channels = int(target["maxInputChannels"]) or 2
        log(f"pyaudiowpatch loopback: {target['name']} @ {rate}Hz x{channels}ch")
        with p.open(
            format=pyaudio.paFloat32,
            channels=channels,
            rate=rate,
            input=True,
            frames_per_buffer=1024,
            input_device_index=int(target["index"]),
        ) as stream:
            while True:
                data = stream.read(1024, exception_on_overflow=False)
                block = np.frombuffer(data, dtype=np.float32).reshape(-1, channels)
                # Take the LEFT channel: averaging stereo can cancel speech
                # outright when the two channels are (near) anti-phase.
                yield block[:, 0].copy().astype(np.float32), rate


def soundcard_source(device_name: str | None):
    """Fallback capture via soundcard (MediaFoundation loopback). Device rate
    is unknown up front — yield None and let the caller measure it."""
    mic = pick_loopback(device_name)
    with mic.recorder(samplerate=48000) as rec:
        while True:
            data = rec.record(numframes=1024)  # (n, channels) float32
            yield (data[:, 0] if data.ndim > 1 else data).astype(np.float32), None


def main() -> None:
    parser = argparse.ArgumentParser(description="dsh-sound2text capture helper")
    parser.add_argument("--port", type=int, default=3080)
    parser.add_argument("--token", default="")
    parser.add_argument("--device", default="", help="loopback source speaker name (default: system default speaker)")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="no upload; log segments and write wavs to ./debug")
    parser.add_argument(
        "--asr-mode",
        choices=["batch", "stream"],
        default="batch",
        help="batch: post whole VAD segments to the host (default). stream: push audio "
        "to a Paraformer realtime WebSocket and relay partial/final sentences",
    )
    parser.add_argument("--model-dir", default=str(Path(__file__).parent / "models"))
    args = parser.parse_args()

    if args.list_devices:
        import soundcard

        print("speakers (use name with --device):")
        for s in soundcard.all_speakers():
            mark = "*" if s == soundcard.default_speaker() else " "
            print(f" {mark} {s.name}")
        return

    model_path = ensure_model(Path(args.model_dir))
    vad = Vad(model_path)
    seg = Segmenter()
    url = f"http://127.0.0.1:{args.port}/api/sound2text/segment"
    stream_text_url = f"http://127.0.0.1:{args.port}/api/sound2text/stream/text"

    pump: StreamPump | None = None
    if args.asr_mode == "stream":
        from stream_asr import ParaformerStream

        api_key = os.environ.get("S2T_STREAM_API_KEY", "")
        ws_url = os.environ.get("S2T_STREAM_URL", "")
        if not ws_url:
            wsid = os.environ.get("S2T_STREAM_WORKSPACE_ID", "")
            if wsid:
                ws_url = f"wss://{wsid}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
        if not api_key or not ws_url:
            raise SystemExit(
                "流式模式缺少配置：需要 S2T_STREAM_API_KEY，以及 S2T_STREAM_URL 或\n"
                "S2T_STREAM_WORKSPACE_ID（阿里云百炼控制台获取，详见 README）"
            )
        model_id = os.environ.get("S2T_STREAM_MODEL", "paraformer-realtime-v2")
        language = os.environ.get("S2T_STREAM_LANGUAGE", "")
        ps = ParaformerStream(ws_url, api_key, model=model_id, language=language, log=log)
        import atexit

        atexit.register(ps.close)  # finish-task + close on Ctrl+C exit
        post = None if args.dry_run else lambda t, s, e, f: post_stream_text(stream_text_url, args.token, t, s, e, f)
        pump = StreamPump(ps, post=post)
        log(f"stream ASR: {model_id} via {ws_url}")

    debug_dir = Path(__file__).parent / "debug"
    keep_wav = args.dry_run or os.environ.get("S2T_KEEP_WAV") == "1"
    if keep_wav:
        debug_dir.mkdir(exist_ok=True)

    from scipy.signal import resample_poly

    # Prefer pyaudiowpatch (proper WASAPI loopback); fall back to soundcard.
    log(f"dsh-sound2text helper v{HELPER_VERSION}")
    source = None
    try:
        import pyaudiowpatch  # noqa: F401

        gen = pyaudiowpatch_source(args.device or None)
        first = next(gen)  # force device open now so failures can fall back
        import itertools

        source = itertools.chain([first], gen)
    except ImportError:
        log("pyaudiowpatch 未安装，使用 soundcard 后端（建议 pip install pyaudiowpatch）")
    except Exception as e:  # noqa: BLE001
        log(f"pyaudiowpatch 启动失败（{e}），改用 soundcard 后端")
    if source is None:
        source = soundcard_source(args.device or None)

    # ---- 5 s capture self-test: prove the loopback actually sees signal ----
    log("自检中：请现在播放任意有声音频（5 秒）…")
    test_blocks = []
    test_samples = 0
    need = int(5 * 48000)
    try:
        for mono, dev_rate in source:
            test_blocks.append((mono, dev_rate))
            test_samples += len(mono)
            if test_samples >= need:
                break
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"自检期间采集失败: {e}")
    test_audio = np.concatenate([b for b, _ in test_blocks])
    test_rms = float(np.sqrt(np.mean(np.square(test_audio))))
    test_peak = float(np.max(np.abs(test_audio))) if test_audio.size else 0.0
    if keep_wav:
        scaled = np.clip(test_audio * (0.5 / test_peak), -1, 1) if 1e-4 < test_peak < 0.25 else test_audio
        safe_write_wav(debug_dir / f"selftest_{int(time.time())}.wav", scaled)
    if test_rms > 0.002:
        log(f"✓ 自检通过：捕获到信号 rms={test_rms:.4f} peak={test_peak:.4f}")
    else:
        log(
            f"✗ 自检失败：捕获到纯静音 rms={test_rms:.6f} peak={test_peak:.6f}\n"
            "  声音没有经过正在采集的输出设备。请依次检查：\n"
            "  1) 现在是否正在播放音频？音源音量是否为 0？\n"
            "  2) 任务栏喇叭图标：当前输出设备是否就是采集的设备\n"
            "     （换设备后需停止/重新开始监听）\n"
            "  3) python helper/main.py --list-devices 查看设备，用 S2T_DEVICE 指定"
        )
    import itertools

    source = itertools.chain(test_blocks, source)

    native_buf: list[np.ndarray] = []
    frames_seen = 0
    t0 = time.monotonic()
    measured_rate = 48000.0
    ratio = Fraction(1, 3)  # 48000 -> 16000
    rate_confirmed = False
    seg_count = 0

    for mono, dev_rate in source:
        native_buf.append(mono)
        frames_seen += len(mono)

        if dev_rate is not None and not rate_confirmed:
            measured_rate = float(dev_rate)
            g = math.gcd(int(dev_rate), TARGET_RATE)
            ratio = Fraction(TARGET_RATE // g, int(dev_rate) // g)
            rate_confirmed = True
            log(f"device rate {dev_rate} Hz -> resample ratio {ratio}")
            native_buf = []
            continue

        # soundcard fallback: one-shot rate calibration after ~1.5 s
        if not rate_confirmed:
            elapsed = time.monotonic() - t0
            if elapsed > 1.5 and frames_seen > 1000:
                est = frames_seen / elapsed
                if abs(est - measured_rate) / measured_rate > 0.02:
                    measured_rate = est
                    g = math.gcd(int(round(est)), TARGET_RATE)
                    ratio = Fraction(TARGET_RATE // g, int(round(est)) // g)
                    log(f"measured device rate {est:.0f} Hz -> resample ratio {ratio}")
                else:
                    log(f"measured device rate {est:.0f} Hz (matches 48k assumption)")
                rate_confirmed = True
                native_buf = []  # restart framing against the confirmed rate
                continue

        frame_native = int(round(measured_rate * FRAME_SEC))
        buf = np.concatenate(native_buf)
        n_frames = len(buf) // frame_native if frame_native else 0
        if n_frames == 0:
            continue
        usable = n_frames * frame_native
        native_buf = [buf[usable:]]

        mono16 = resample_poly(buf[:usable], ratio.numerator, ratio.denominator).astype(np.float32)

        now_ms = time.time() * 1000
        for i in range(0, len(mono16) - 511, 512):
            frame = mono16[i : i + 512]
            if pump is not None:
                pump.handle(frame, vad.prob(frame))
                continue
            out = seg.feed(frame, vad.prob(frame), now_ms)
            if out is not None:
                audio, start_ms, gain = out
                seg_count += 1
                wav = wav_bytes(audio)
                rms = float(np.sqrt(np.mean(np.square(audio))))
                log(
                    f"segment #{seg_count}: {len(audio) / TARGET_RATE:.1f}s "
                    f"rms={rms:.4f}{' (x%.0f gain)' % gain if gain > 1.01 else ''}"
                )
                if keep_wav:
                    safe_write_wav(debug_dir / f"seg_{int(time.time())}_{seg_count}.wav", audio)
                if args.dry_run:
                    continue
                if not post_segment(url, args.token, start_ms, now_ms, wav):
                    log("segment dropped after retries")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
