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
import sys
import time
import urllib.request
import wave
from fractions import Fraction
from pathlib import Path

import numpy as np

TARGET_RATE = 16000
FRAME_SEC = 0.032                     # 32 ms VAD frame
# VAD state machine tuning
START_PROB = 0.60                     # probability to enter speech
END_PROB = 0.45                       # probability to stay in speech
SILENCE_EXIT_SEC = 0.7                # trailing silence that closes a segment
MAX_SEGMENT_SEC = 10.0                # force-cut long continuous speech
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

    def clear(self) -> None:
        self.buf: list[np.ndarray] = []   # short pre-roll ring, always fed
        self.in_speech = False
        self.silence_run = 0.0
        self.speech_run = 0.0
        self.seg: list[np.ndarray] = []
        self.seg_start: float | None = None

    def feed(self, frame: np.ndarray, p: float, now_ms: float) -> tuple[np.ndarray, float] | None:
        self.buf.append(frame)
        if len(self.buf) > 3:
            del self.buf[: -3]

        if not self.in_speech:
            if p >= START_PROB:
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
        return np.clip(audio, -1.0, 1.0), start


def wav_bytes(pcm16: np.ndarray) -> bytes:
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(pcm16.astype(np.int16).tobytes())
    return bio.getvalue()


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


def main() -> None:
    parser = argparse.ArgumentParser(description="dsh-sound2text capture helper")
    parser.add_argument("--port", type=int, default=3080)
    parser.add_argument("--token", default="")
    parser.add_argument("--device", default="", help="loopback source speaker name (default: system default speaker)")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="no upload; log segments and write wavs to ./debug")
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
    mic = pick_loopback(args.device or None)
    url = f"http://127.0.0.1:{args.port}/api/sound2text/segment"

    debug_dir = Path(__file__).parent / "debug"
    if args.dry_run:
        debug_dir.mkdir(exist_ok=True)

    from scipy.signal import resample_poly

    log("opening loopback stream (48 kHz assumption, auto-measuring device rate)…")
    with mic.recorder(samplerate=48000) as rec:
        native_buf: list[np.ndarray] = []
        frames_seen = 0
        t0 = time.monotonic()
        measured_rate = 48000.0
        ratio = Fraction(1, 3)  # 48000 -> 16000
        rate_confirmed = False
        seg_count = 0

        while True:
            data = rec.record(numframes=1024)  # (n, channels) float32
            mono = data.mean(axis=1).astype(np.float32)
            native_buf.append(mono)
            frames_seen += len(mono)

            # one-shot rate calibration after ~1.5 s of capture
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
                out = seg.feed(frame, vad.prob(frame), now_ms)
                if out is not None:
                    audio, start_ms = out
                    seg_count += 1
                    wav = wav_bytes(audio)
                    log(f"segment #{seg_count}: {len(audio) / TARGET_RATE:.1f}s")
                    if args.dry_run:
                        (debug_dir / f"seg_{int(time.time())}_{seg_count}.wav").write_bytes(wav)
                    elif not post_segment(url, args.token, start_ms, now_ms, wav):
                        log("segment dropped after retries")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
