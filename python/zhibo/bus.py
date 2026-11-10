from __future__ import annotations

from .envelope import validate_envelope
from .util import sleep_ms


def _noop(*args, **kwargs):
    return None


def _field(target, *names, default=None):
    for name in names:
        if isinstance(target, dict):
            if target.get(name) is not None:
                return target[name]
        elif hasattr(target, name):
            return getattr(target, name)
    return default


def _agent_id(agent):
    return _field(agent, "id")


def _agent_status(agent):
    return _field(agent, "status")


def _agent_role(agent):
    return _field(agent, "logicalRole", "logical_role")


class MessageBus:
    def __init__(self, options=None, *, emit=None, max_log=600, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        self.agents = {}
        self.log = []
        self.collectors = []
        self.emit = merged.get("emit", emit) or _noop
        self.max_log = merged.get("max_log", merged.get("maxLog", max_log))
        self.counts = {"sent": 0, "broadcast": 0, "rerouted": 0, "dropped": 0}

    def register(self, agent):
        self.agents[_agent_id(agent)] = agent
        return None

    def unregister(self, agent_id):
        self.agents.pop(agent_id, None)
        return None

    def get(self, agent_id):
        return self.agents.get(agent_id)

    def list(self):
        return list(self.agents.values())

    def resolve_targets(self, env):
        receiver = env.get("receiver")
        sender = env.get("sender")
        if receiver == "*" or receiver is None:
            return [
                agent
                for agent in self.list()
                if _agent_id(agent) != sender and _agent_status(agent) == "active"
            ]
        direct = self.agents.get(receiver)
        if direct is not None:
            logical = direct
        else:
            logical = next((a for a in self.list() if _agent_role(a) == receiver), None)
        if logical is None:
            return []
        if _agent_status(logical) == "active":
            return [logical]
        if _agent_status(logical) == "standby":
            active_replica = next(
                (
                    a
                    for a in self.list()
                    if _agent_role(a) == _agent_role(logical) and _agent_status(a) == "active"
                ),
                None,
            )
            return [active_replica] if active_replica is not None else []
        replica = next(
            (
                a
                for a in self.list()
                if _agent_role(a) == _agent_role(logical)
                and _agent_id(a) != _agent_id(logical)
                and _agent_status(a) == "active"
            ),
            None,
        )
        return [replica] if replica is not None else []

    def send(self, env):
        if not validate_envelope(env):
            raise ValueError("Invalid A2A envelope")
        targets = self.resolve_targets(env)
        receiver = env.get("receiver")
        is_broadcast = receiver == "*" or receiver is None
        record = {
            **env,
            "deliveredTo": [_agent_id(agent) for agent in targets],
            "broadcast": is_broadcast,
        }
        self._append_log(record)
        self.counts["sent"] += 1
        if is_broadcast:
            self.counts["broadcast"] += 1

        if not targets:
            expected = self.agents.get(receiver)
            if expected is not None and _agent_status(expected) != "active":
                self.counts["dropped"] += 1
                self.emit(
                    "a2a.unreachable",
                    {
                        "agent": receiver,
                        "logicalRole": _agent_role(expected),
                        "envelope": record,
                        "reason": "no-active-instance",
                    },
                )
            self._notify_collectors(record)
            self.emit("envelope", record)
            return record

        for agent in targets:
            enqueue = getattr(agent, "enqueue", None)
            if callable(enqueue):
                enqueue(record)
        self._notify_collectors(record)
        self.emit("envelope", record)
        return record

    def broadcast(self, env):
        return self.send({**env, "receiver": "*"})

    def log_system(self, env, note=""):
        record = {**env, "deliveredTo": [], "system": True, "note": note}
        self._append_log(record)
        self.counts["sent"] += 1
        self.emit("envelope", record)
        return record

    def collect(self, options=None, *, trace_id=None, performative=None, timeout_ms=260, **aliases):
        merged = {}
        if isinstance(options, dict):
            merged.update(options)
        elif options is not None:
            merged["traceId"] = options
        merged.update(aliases)
        trace_id = merged.get("traceId", merged.get("trace_id", trace_id))
        performative = merged.get("performative", performative)
        timeout_ms = merged.get("timeoutMs", merged.get("timeout_ms", timeout_ms))

        received = []

        def collector(env):
            if env.get("traceId") != trace_id:
                return
            if performative and env.get("performative") != performative:
                return
            if env.get("receiver") == "*":
                return
            received.append(env)

        self.collectors.append(collector)
        try:
            sleep_ms(timeout_ms if timeout_ms is not None else 260)
        finally:
            if collector in self.collectors:
                self.collectors.remove(collector)
        return received

    def recent(self, limit=40):
        return self.log[-limit:][::-1]

    def stats(self):
        performatives = {}
        for item in self.log:
            key = item.get("performative")
            performatives[key] = (performatives.get(key) or 0) + 1
        return {
            **self.counts,
            "logSize": len(self.log),
            "performatives": performatives,
            "agents": [
                {"id": _agent_id(agent), "status": _agent_status(agent)} for agent in self.list()
            ],
        }

    def _append_log(self, record):
        self.log.append(record)
        if len(self.log) > self.max_log:
            del self.log[: len(self.log) - self.max_log]

    def _notify_collectors(self, record):
        for collector in list(self.collectors):
            collector(record)
