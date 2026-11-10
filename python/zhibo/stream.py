from __future__ import annotations

import threading
import time
from concurrent.futures import Future

from .util import now_ms, percentile, round_to


def _noop(*args, **kwargs):
    return None


def _perf_ms():
    return time.perf_counter() * 1000


def _field(target, name, default=None):
    if isinstance(target, dict):
        return target.get(name, default)
    return getattr(target, name, default)


class _Entry:
    __slots__ = ("item", "t0", "future")

    def __init__(self, item, t0, future):
        self.item = item
        self.t0 = t0
        self.future = future


class StreamEngine:
    def __init__(self, options=None, *, window_ms=80, max_batch=32, backpressure_queue=48,
                 handler=None, emit=None, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        self.window_ms = merged.get("window_ms", merged.get("windowMs", window_ms))
        self.max_batch = merged.get("max_batch", merged.get("maxBatch", max_batch))
        self.backpressure_queue = merged.get(
            "backpressure_queue", merged.get("backpressureQueue", backpressure_queue)
        )
        self.handler = merged.get("handler", handler)
        self.emit = merged.get("emit", emit) or _noop
        self.queue = []
        self.timer = None
        self.processing = False
        self.latencies = []
        self.metrics = {
            "total": 0,
            "processed": 0,
            "dropped": 0,
            "batches": 0,
            "errors": 0,
            "peakQueue": 0,
            "lastFlushAt": None,
        }
        self._lock = threading.RLock()

    def ingest(self, item):
        t0 = _perf_ms()
        future = Future()
        with self._lock:
            self.metrics["total"] += 1
            dropped_payload = None
            should_flush = False
            if _field(item, "priority") == "low" and len(self.queue) >= self.backpressure_queue:
                self.metrics["dropped"] += 1
                self._record_latency(_perf_ms() - t0 + 0.05)
                dropped_payload = {
                    "dropped": self.metrics["dropped"],
                    "queue": len(self.queue),
                    "reason": "low-value under pressure",
                }
            else:
                self.queue.append(_Entry(item, t0, future))
                self.metrics["peakQueue"] = max(self.metrics["peakQueue"], len(self.queue))
                should_flush = len(self.queue) >= self.max_batch

        if dropped_payload is not None:
            self.emit("stream.backpressure", dropped_payload)
            future.set_result({"dropped": True, "item": item, "latencyMs": 0.1})
            return future

        if should_flush:
            self.flush()
        else:
            self.schedule()
        return future

    def schedule(self):
        with self._lock:
            if self.timer is not None or self.processing:
                return
            timer = threading.Timer(max(0, self.window_ms) / 1000, self._on_window)
            timer.daemon = True
            self.timer = timer
            timer.start()

    def flush(self):
        with self._lock:
            timer = self.timer
            self.timer = None
            if self.processing:
                if timer is not None:
                    timer.cancel()
                return None
            self.processing = True
            if timer is not None:
                timer.cancel()

        try:
            while True:
                with self._lock:
                    if not self.queue:
                        break
                    batch = self.queue[: self.max_batch]
                    del self.queue[: len(batch)]
                self._run_batch(batch)
        finally:
            with self._lock:
                self.processing = False
            if self.queue:
                self.schedule()
        return None

    def record_latency(self, ms):
        with self._lock:
            self._record_latency(ms)

    def snapshot(self):
        with self._lock:
            latencies = list(self.latencies)
            metrics = dict(self.metrics)
            queue = len(self.queue)
            window_ms = self.window_ms
            max_batch = self.max_batch
            backpressure_queue = self.backpressure_queue
        return {
            **metrics,
            "p50": round_to(percentile(latencies, 50), 2),
            "p95": round_to(percentile(latencies, 95), 2),
            "p99": round_to(percentile(latencies, 99), 2),
            "queue": queue,
            "windowMs": window_ms,
            "maxBatch": max_batch,
            "backpressureQueue": backpressure_queue,
            "measured": True,
        }

    def reset_metrics(self):
        with self._lock:
            self.latencies = []
            self.metrics = {
                "total": 0,
                "processed": 0,
                "dropped": 0,
                "batches": 0,
                "errors": 0,
                "peakQueue": 0,
                "lastFlushAt": None,
            }

    def _record_latency(self, ms):
        self.latencies.append(ms)
        if len(self.latencies) > 4000:
            del self.latencies[: len(self.latencies) - 4000]

    def _on_window(self):
        with self._lock:
            self.timer = None
        self.flush()

    def _run_batch(self, batch):
        started = _perf_ms()
        try:
            results = self.handler([entry.item for entry in batch], {"batchSize": len(batch)})
            now = _perf_ms()
            resolved = []
            with self._lock:
                for index, entry in enumerate(batch):
                    latency = now - entry.t0
                    self._record_latency(latency)
                    self.metrics["processed"] += 1
                    resolved.append((entry, latency, _result_at(results, index)))
            for entry, latency, value in resolved:
                entry.future.set_result({
                    "dropped": False,
                    "item": entry.item,
                    "result": value,
                    "latencyMs": round_to(latency, 2),
                })
        except Exception as error:
            with self._lock:
                self.metrics["errors"] += 1
            for entry in batch:
                self.record_latency(_perf_ms() - entry.t0)
                entry.future.set_result({
                    "dropped": False,
                    "item": entry.item,
                    "result": None,
                    "error": str(error),
                })
        with self._lock:
            self.metrics["batches"] += 1
            self.metrics["lastFlushAt"] = now_ms()
            self.metrics["batchLatencyMs"] = round_to(_perf_ms() - started, 2)
        self.emit("stream.metrics", self.snapshot())


def _result_at(results, index):
    if results is None:
        return None
    if isinstance(results, dict):
        return results.get(index)
    try:
        value = results[index]
    except (IndexError, KeyError, TypeError):
        return None
    return value
