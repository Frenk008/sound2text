# -*- coding: utf-8 -*-
"""Streaming ASR client for Aliyun Bailian (DashScope) Paraformer realtime.

Speaks the dashscope WebSocket inference protocol:

    connect wss://<workspace>.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
      header: Authorization: Bearer <api key>
    ->  run-task            (json text frame)
    <-  task-started
    ->  binary pcm 16k 16-bit mono frames
    <-  result-generated    (payload.output.sentence: text/begin_time/end_time/
                             sentence_end; heartbeat frames are marked)
    ->  finish-task
    <-  task-finished       (connection stays open, reusable for another run-task)

The task lifecycle is driven by the caller (feed while local VAD says speech,
stop_task after idle) so silence never reaches the metered stream.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Callable

import websocket  # pip install websocket-client

SentenceCB = Callable[[str, "int | None", "int | None", bool], None]

SEND_CHUNK = 3200  # 100 ms of 16 kHz 16-bit mono


class ParaformerStream:
    def __init__(
        self,
        url: str,
        api_key: str,
        model: str = "paraformer-realtime-v2",
        language: str = "",
        on_sentence: SentenceCB | None = None,
        log: Callable[[str], None] = print,
    ) -> None:
        self.url = url
        self.api_key = api_key
        self.model = model
        self.language = language
        self.on_sentence = on_sentence
        self.log = log
        self.last_error = ""
        self._ws: websocket.WebSocket | None = None
        self._alive = False
        self._send_lock = threading.Lock()
        self._started = threading.Event()
        self._done = threading.Event()
        self._task_id = ""
        self.task_open = False
        self._epoch_ms: int | None = None
        self._out = bytearray()

    # -- connection ---------------------------------------------------------------
    def _connect(self) -> None:
        self._ws = websocket.create_connection(
            self.url,
            header=[f"Authorization: Bearer {self.api_key}"],
            timeout=10,
        )
        self._alive = True
        threading.Thread(target=self._recv_loop, daemon=True, name="s2t-asr-recv").start()

    def _recv_loop(self) -> None:
        while self._alive and self._ws is not None:
            try:
                msg = self._ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception as e:  # noqa: BLE001
                if self._alive:
                    self.last_error = str(e)
                    self.log(f"stream connection lost: {e}")
                break
            if isinstance(msg, bytes) or not msg:
                continue
            try:
                ev = json.loads(msg)
            except ValueError:
                continue
            header = ev.get("header") or {}
            event = header.get("event", "")
            if event == "task-started":
                self._started.set()
            elif event == "result-generated":
                sentence = ((ev.get("payload") or {}).get("output") or {}).get("sentence") or {}
                if sentence.get("heartbeat"):
                    continue
                text = str(sentence.get("text") or "")
                if text and self.on_sentence:
                    try:
                        self.on_sentence(text, sentence.get("begin_time"), sentence.get("end_time"), bool(sentence.get("sentence_end")))
                    except Exception as e:  # noqa: BLE001
                        self.log(f"sentence callback error: {e}")
            elif event == "task-finished":
                self.task_open = False
                self._done.set()
            elif event == "task-failed":
                self.last_error = f'{header.get("error_code")}: {header.get("error_message")}'
                self.log(f"stream task failed: {self.last_error}")
                self.task_open = False
                self._done.set()
                # docs: task-failed kills the connection; force a reconnect next task
                self._alive = False
                try:
                    self._ws.close()
                except Exception:  # noqa: BLE001
                    pass
                return
        # socket broke: unblock anyone waiting on task events
        self._alive = False
        self.task_open = False
        self._started.set()
        self._done.set()

    # -- task lifecycle -----------------------------------------------------------
    def start_task(self, timeout: float = 10.0) -> bool:
        if self.task_open:
            return True
        self._started.clear()
        self._done.clear()
        self._epoch_ms = None
        self._out.clear()
        if not self._alive:
            try:
                self._connect()
            except Exception as e:  # noqa: BLE001
                self.last_error = str(e)
                self.log(f"stream connect failed: {e}")
                return False
        self._task_id = str(uuid.uuid4())
        params: dict = {
            "format": "pcm",
            "sample_rate": 16000,
            "punctuation_prediction_enabled": True,
            "max_sentence_silence": 600,
        }
        if self.language:
            params["language_hints"] = [self.language]
        run = {
            "header": {"action": "run-task", "task_id": self._task_id, "streaming": "duplex"},
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": self.model,
                "parameters": params,
                "input": {},
            },
        }
        try:
            with self._send_lock:
                assert self._ws is not None
                self._ws.send(json.dumps(run))
        except Exception as e:  # noqa: BLE001
            self.last_error = str(e)
            self.log(f"run-task send failed: {e}")
            self._alive = False
            return False
        if not self._started.wait(timeout):
            self.last_error = "task-started timeout"
            self.log(self.last_error)
            return False
        self.task_open = True
        return True

    def stop_task(self, timeout: float = 8.0) -> None:
        if not self.task_open:
            return
        self._out.clear()
        finish = {
            "header": {"action": "finish-task", "task_id": self._task_id, "streaming": "duplex"},
            "payload": {"input": {}},
        }
        try:
            with self._send_lock:
                if self._ws is not None and self._alive:
                    self._ws.send(json.dumps(finish))
        except Exception as e:  # noqa: BLE001
            self.log(f"finish-task send failed: {e}")
            self._alive = False
        self._done.wait(timeout)
        self.task_open = False
        self._epoch_ms = None

    def close(self) -> None:
        if self.task_open:
            self.stop_task(timeout=3.0)
        self._alive = False
        try:
            if self._ws is not None:
                self._ws.close()
        except Exception:  # noqa: BLE001
            pass

    # -- audio --------------------------------------------------------------------
    def feed(self, pcm16: bytes) -> None:
        """Queue 16 kHz mono 16-bit PCM; flushes at ~100 ms granularity."""
        if not self.task_open:
            return
        self._out += pcm16
        if len(self._out) >= SEND_CHUNK:
            self.flush()

    def flush(self) -> None:
        if not self.task_open or not self._out:
            return
        if self._epoch_ms is None:
            # sentence begin/end times are offsets from the first pushed byte
            self._epoch_ms = int(time.time() * 1000)
        data = bytes(self._out)
        self._out.clear()
        try:
            with self._send_lock:
                assert self._ws is not None
                self._ws.send_binary(data)
        except Exception as e:  # noqa: BLE001
            self.last_error = str(e)
            self.log(f"audio send failed: {e}")
            self._alive = False
            self.task_open = False

    def wallclock(self, offset_ms: "int | None") -> int:
        if offset_ms is not None and self._epoch_ms is not None:
            return self._epoch_ms + int(offset_ms)
        return int(time.time() * 1000)
