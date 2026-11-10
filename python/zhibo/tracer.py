from __future__ import annotations

import inspect
import time
from collections.abc import Callable
from datetime import datetime, timezone

from .util import now_ms, round_to, trace_code, uid


def _merge(options, kwargs) -> dict:
    merged: dict = {}
    if isinstance(options, dict):
        merged.update(options)
    merged.update(kwargs)
    return merged


def _pick(options: dict, *names: str, default=None):
    for name in names:
        value = options.get(name)
        if value is not None:
            return value
    return default


def _as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _noop(*args, **kwargs) -> None:
    return None


def _to_epoch_ms(value) -> int | float:
    if value is None:
        return float("nan")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    raw = str(value).strip()
    if raw.endswith(("Z", "z")):
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return float("nan")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class Tracer:
    def __init__(self, options=None, **kwargs) -> None:
        merged = _merge(options, kwargs)
        if callable(options) and not isinstance(options, dict):
            merged["emit"] = options
        emit = _pick(merged, "emit")
        self.emit: Callable[..., object] = emit if callable(emit) else _noop
        self.max_traces = _pick(merged, "maxTraces", "max_traces", default=80)
        self.traces: dict[str, dict] = {}
        self.order: list[str] = []

    def start(self, name, meta=None) -> dict:
        trace = {
            "id": trace_code(),
            "name": name,
            "meta": {} if meta is None else meta,
            "startedAt": now_ms(),
            "finishedAt": None,
            "durationMs": None,
            "status": "running",
            "spans": [],
        }
        self.traces[trace["id"]] = trace
        self.order.insert(0, trace["id"])
        if len(self.order) > self.max_traces:
            removed = self.order.pop()
            self.traces.pop(removed, None)
        return trace

    def span(self, trace, name, agent=None, meta=None) -> dict:
        record = {
            "id": uid("SPN"),
            "name": name,
            "agent": agent,
            "startedAt": now_ms(),
            "durationMs": None,
            "status": "running",
            "meta": {} if meta is None else meta,
        }
        trace["spans"].append(record)
        begin = time.perf_counter()

        def end(status="ok", extra=None) -> None:
            record["durationMs"] = round_to((time.perf_counter() - begin) * 1000, 2)
            record["status"] = status
            record["meta"] = {**_as_dict(record["meta"]), **_as_dict(extra)}

        return {"span": record, "end": end}

    def track(self, trace, name, agent=None, fn=None, meta=None):
        handle = self.span(trace, name, agent, meta)
        end = handle["end"]
        try:
            result = fn() if fn is not None else None
        except Exception as error:
            end("error", {"error": str(error)})
            raise
        if inspect.isawaitable(result):
            return self._await_span(end, result)
        end("ok")
        return result

    async def _await_span(self, end, awaitable):
        try:
            result = await awaitable
        except Exception as error:
            end("error", {"error": str(error)})
            raise
        end("ok")
        return result

    def finish(self, trace, status="ok", summary=None) -> dict:
        trace["finishedAt"] = now_ms()
        started = trace.get("startedAt")
        trace["durationMs"] = (
            trace["finishedAt"] - started if _is_number(started) else float("nan")
        )
        trace["status"] = status
        if summary:
            trace["summary"] = summary
        self.emit("trace", self.summary(trace))
        return trace

    def get(self, trace_id) -> dict | None:
        try:
            return self.traces.get(trace_id)
        except TypeError:
            return None

    def import_trace(self, trace) -> dict | None:
        if not trace or not trace.get("id"):
            return None
        now = now_ms()
        started = trace.get("startedAt")
        finished = trace.get("finishedAt")
        normalized = {
            "status": "ok",
            "spans": [],
            "durationMs": trace.get("durationMs") if trace.get("durationMs") is not None else 0,
            "startedAt": _to_epoch_ms(started) if started else now,
            "finishedAt": _to_epoch_ms(finished) if finished else now,
        }
        normalized.update(trace)
        self.traces[normalized["id"]] = normalized
        self.order.append(normalized["id"])
        return normalized

    def summary(self, trace) -> dict | None:
        if trace is None:
            return None
        return {
            "id": trace.get("id"),
            "name": trace.get("name"),
            "meta": trace.get("meta"),
            "startedAt": trace.get("startedAt"),
            "finishedAt": trace.get("finishedAt"),
            "durationMs": trace.get("durationMs"),
            "status": trace.get("status"),
            "summary": trace.get("summary") if trace.get("summary") is not None else None,
            "spans": trace.get("spans"),
        }

    def list(self, limit=20) -> list:
        items = [self.summary(self.traces.get(trace_id)) for trace_id in self.order[:limit]]
        return [item for item in items if item]
