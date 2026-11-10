from __future__ import annotations

import time

from .util import now_ms, round_to

RISK_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def _noop(*args, **kwargs):
    return None


def _deny(name, context):
    return False


def _perf_ms():
    return time.perf_counter() * 1000


class ToolError(RuntimeError):
    code = None

    @property
    def message(self):
        return str(self)


class ApprovalRequiredError(ToolError):
    code = "APPROVAL_REQUIRED"


class ToolEntry:
    __slots__ = ("spec", "handler")

    def __init__(self, spec, handler):
        self.spec = spec
        self.handler = handler

    def __getitem__(self, key):
        if key in self.__slots__:
            return getattr(self, key)
        raise KeyError(key)

    def get(self, key, default=None):
        return getattr(self, key, default)


class MCPRegistry:
    def __init__(self, options=None, *, emit=None, approval_validator=None, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        self.tools = {}
        self.emit = merged.get("emit", emit) or _noop
        validator = merged.get("approval_validator", merged.get("approvalValidator", approval_validator))
        self.approval_validator = validator if callable(validator) else _deny
        self.stats = {}

    def register(self, spec, handler):
        spec = spec if isinstance(spec, dict) else {}
        if not spec.get("name") or not spec.get("description"):
            raise ToolError("Tool spec requires name and description")
        if not callable(handler):
            raise ToolError("Tool handler must be a function")
        normalized = {
            "version": "1.0.0",
            "riskLevel": "low",
            "category": "general",
            "source": "builtin",
            "requiresApproval": False,
            "parameters": {"type": "object", "properties": {}, "required": []},
            **spec,
        }
        name = normalized["name"]
        self.tools[name] = ToolEntry(normalized, handler)
        if not self.stats.get(name):
            self.stats[name] = {"calls": 0, "errors": 0, "totalMs": 0, "lastCalledAt": None}
        self.emit("tool.registered", {"name": name, "spec": normalized})
        return normalized

    def unregister(self, name):
        entry = self.tools.get(name)
        if entry is None:
            return False
        if entry.spec.get("source") == "builtin":
            raise ToolError("Builtin tools cannot be removed")
        self.tools.pop(name, None)
        self.stats.pop(name, None)
        self.emit("tool.removed", {"name": name})
        return True

    def get(self, name):
        return self.tools.get(name)

    def list(self):
        return [
            {**entry.spec, "stats": self.stats.get(entry.spec.get("name"))}
            for entry in self.tools.values()
        ]

    def validate_args(self, spec, args):
        args = args if isinstance(args, dict) else {}
        parameters = spec.get("parameters") or {}
        required = parameters.get("required") or []
        for key in required:
            if args.get(key) is None:
                raise ToolError(f"Missing required argument: {key}")
        for key, schema in (parameters.get("properties") or {}).items():
            value = args.get(key)
            if value is None:
                continue
            expected = (schema or {}).get("type")
            if expected == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
                raise ToolError(f"{key} must be number")
            if expected == "string" and not isinstance(value, str):
                raise ToolError(f"{key} must be string")
            if expected == "boolean" and not isinstance(value, bool):
                raise ToolError(f"{key} must be boolean")
            if expected == "array" and not isinstance(value, (list, tuple)):
                raise ToolError(f"{key} must be array")

    def call(self, name, args=None, context=None):
        args = args if isinstance(args, dict) else {}
        context = context if isinstance(context, dict) else {}
        entry = self.tools.get(name)
        if entry is None:
            raise ToolError(f"Tool not found: {name}")
        self.validate_args(entry.spec, args)
        approval_id = context.get("approvalId")
        if approval_id is None:
            approval_id = args.get("approvalId")
        ctx = {**context, "approvalId": approval_id}
        if entry.spec.get("requiresApproval") and not self.approval_validator(name, ctx):
            raise ApprovalRequiredError(f"Tool {name} requires a valid consensus approval")

        started = _perf_ms()
        stat = self.stats.setdefault(
            name, {"calls": 0, "errors": 0, "totalMs": 0, "lastCalledAt": None}
        )
        stat["calls"] += 1
        stat["lastCalledAt"] = now_ms()
        try:
            result = entry.handler(args, {**ctx, "spec": entry.spec})
            duration_ms = round_to(_perf_ms() - started, 2)
            stat["totalMs"] += duration_ms
            if not ctx.get("silent"):
                self.emit(
                    "tool.called",
                    {
                        "name": name,
                        "risk": entry.spec.get("riskLevel"),
                        "durationMs": duration_ms,
                        "approvalId": ctx.get("approvalId"),
                        "traceId": ctx.get("traceId"),
                    },
                )
            return {"ok": True, "result": result, "durationMs": duration_ms, "tool": name}
        except Exception as error:
            stat["errors"] += 1
            self.emit(
                "tool.error",
                {
                    "name": name,
                    "message": str(error),
                    "traceId": context.get("traceId"),
                },
            )
            raise

    def schemas(self):
        return [
            {
                "name": tool.get("name"),
                "description": tool.get("description"),
                "riskLevel": tool.get("riskLevel"),
                "inputSchema": tool.get("parameters"),
            }
            for tool in self.list()
        ]

    def snapshot(self):
        rows = []
        for tool in self.list():
            stats = tool.get("stats") or {}
            calls = stats.get("calls") or 0
            rows.append({
                **tool,
                "riskRank": RISK_ORDER.get(tool.get("riskLevel"), 0),
                "avgMs": round_to(stats.get("totalMs", 0) / calls, 2) if calls else 0,
            })
        return sorted(rows, key=lambda item: item.get("name") or "")
