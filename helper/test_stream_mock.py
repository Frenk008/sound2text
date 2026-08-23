# -*- coding: utf-8 -*-
"""Local self-test for the streaming path without a real DashScope key.

Spins up a mock Paraformer WebSocket server that follows the dashscope
protocol (run-task -> task-started -> binary frames -> result-generated ->
finish-task -> task-finished), then drives StreamPump + ParaformerStream with
synthetic "speech" frames and checks the partial/final callbacks fire with
sane wall-clock timestamps.
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time

import numpy as np
import websockets

sys.path.insert(0, ".")
from main import FRAME_SEC, START_PROB, StreamPump  # noqa: E402
from stream_asr import ParaformerStream  # noqa: E402

sentences: list[tuple[str, str, int, int, bool]] = []  # (phase, text, start, end, final)
received_bytes: list[bytes] = []


async def serve(ws):
    async for raw in ws:
        if isinstance(raw, bytes):
            received_bytes.append(raw)
            continue
        msg = json.loads(raw)
        action = msg.get("header", {}).get("action")
        task_id = msg.get("header", {}).get("task_id")
        if action == "run-task":
            assert msg["payload"]["model"] == "paraformer-realtime-v2", msg["payload"]["model"]
            assert msg["payload"]["parameters"]["format"] == "pcm"
            await ws.send(json.dumps({"header": {"task_id": task_id, "event": "task-started", "attributes": {}}}))
            # emit a partial then a final once some audio arrived
            await asyncio.sleep(0.3)
            await ws.send(json.dumps({
                "header": {"task_id": task_id, "event": "result-generated", "attributes": {}},
                "payload": {"output": {"sentence": {"begin_time": 120, "end_time": None, "text": "你好", "sentence_end": False}}, "usage": None},
            }))
            await asyncio.sleep(0.3)
            await ws.send(json.dumps({
                "header": {"task_id": task_id, "event": "result-generated", "attributes": {}},
                "payload": {"output": {"sentence": {"begin_time": 120, "end_time": 980, "text": "你好世界", "sentence_end": True}}, "usage": {"duration": 1}},
            }))
        elif action == "finish-task":
            await ws.send(json.dumps({"header": {"task_id": task_id, "event": "task-finished", "attributes": {}}, "payload": {"output": {}, "usage": None}}))


async def run_server(stop: threading.Event):
    async with websockets.serve(serve, "127.0.0.1", 18777):
        while not stop.is_set():
            await asyncio.sleep(0.1)


def main() -> None:
    stop = threading.Event()
    t = threading.Thread(target=lambda: asyncio.run(run_server(stop)), daemon=True)
    t.start()
    time.sleep(0.5)

    ps = ParaformerStream("ws://127.0.0.1:18777", "test-key", log=lambda m: print(f"[mock-client] {m}"))

    def on_sentence(text, begin, end, final):
        start = ps.wallclock(begin)
        endw = ps.wallclock(end) if end is not None else int(time.time() * 1000)
        phase = "final" if final else "partial"
        sentences.append((phase, text, start, endw, final))
        print(f"[sentence] {phase}: {text} ({start}..{endw})")

    pump = StreamPump(ps, post=None)
    # pump overwrote on_sentence; re-point it at our recorder via pump._on_sentence replacement
    ps.on_sentence = on_sentence

    speech = (0.3 * np.sin(2 * np.pi * 220 * np.arange(512) / 16000)).astype(np.float32)
    silence = np.zeros(512, dtype=np.float32)
    t0 = time.time()
    # ~1 s of silence first: the noise gate needs a floor before it can arm
    for i in range(int(1.0 / FRAME_SEC)):
        pump.handle(silence, 0.02)
        time.sleep(0.005)
    # ~2 s of speech then ~1.5 s silence (enough to close the utterance, not the task)
    n = int(2.0 / FRAME_SEC)
    for i in range(n):
        pump.handle(speech, 0.95)
        time.sleep(0.005)
    for i in range(int(1.5 / FRAME_SEC)):
        pump.handle(silence, 0.02)
        time.sleep(0.005)

    assert ps.task_open, "task should still be open (idle close is 15 s)"
    # drive idle past the close threshold with accelerated idle ticks
    pump.idle_run = pump.IDLE_CLOSE_SEC
    pump.handle(silence, 0.02)
    assert not ps.task_open, "task should be closed after idle threshold"
    ps.close()
    stop.set()

    partials = [s for s in sentences if not s[4]]
    finals = [s for s in sentences if s[4]]
    assert partials and finals, f"expected partial+final sentences, got: {sentences}"
    assert finals[0][1] == "你好世界"
    assert received_bytes and sum(len(b) for b in received_bytes) > 16000, "no audio reached the server"
    dt = time.time() - t0
    print(f"SELF-TEST OK: {len(partials)} partial + {len(finals)} final, {sum(len(b) for b in received_bytes)} audio bytes, {dt:.1f}s")


if __name__ == "__main__":
    main()
