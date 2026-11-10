from __future__ import annotations

from .util import now_ms


def _noop(*args, **kwargs):
    return None


class Blackboard:
    def __init__(self, options=None, *, emit=None, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        self.state = {
            "stage": "prep",
            "sessionId": None,
            "currentProduct": None,
            "viewers": 0,
            "peakViewers": 0,
            "gmv": 0,
            "orders": 0,
            "interactionRate": 0,
            "cvr": 0,
            "sentiment": 0.82,
            "stockRisk": 0,
            "couponActive": False,
            "riskLevel": "low",
            "latencyP99": 0,
            "updatedAt": now_ms(),
        }
        self.version = 0
        self.emit = merged.get("emit", emit) or _noop
        self.history = []

    def update(self, patch, options=None, *, silent=False, **aliases):
        if isinstance(options, bool):
            options = {"silent": options}
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        silent = merged.get("silent", silent)

        changes = patch if isinstance(patch, dict) else {}
        self.state = {**self.state, **changes, "updatedAt": now_ms()}
        self.version += 1
        entry = {"version": self.version, "patch": patch, "at": now_ms()}
        self.history.append(entry)
        if len(self.history) > 400:
            self.history.pop(0)
        if not silent:
            self.emit("blackboard", self.snapshot())
        return self.state

    def get(self, key):
        return self.state.get(key)

    def snapshot(self):
        return {**self.state, "version": self.version}

    def recent(self, limit=12):
        return self.history[-limit:][::-1]
