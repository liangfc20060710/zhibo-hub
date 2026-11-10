from __future__ import annotations

from .util import now_ms, uid

PERFORMATIVES = [
    "CFP",
    "PROPOSE",
    "AWARD",
    "ACCEPT",
    "REJECT",
    "INFORM",
    "REQUEST",
    "VOTE",
    "VETO",
    "ESCALATE",
    "HEARTBEAT",
]


def _pick(fields, *names, default=None):
    for name in names:
        value = fields.get(name)
        if value is not None:
            return value
    return default


def create_envelope(options=None, *, sender=None, receiver=None, performative="INFORM",
                    content=None, trace_id=None, in_reply_to=None, priority=5, meta=None,
                    **aliases):
    fields = {}
    if isinstance(options, dict):
        fields.update(options)
    elif options is not None:
        raise TypeError("create_envelope expects an options mapping or keyword arguments")
    fields.update(aliases)

    sender = _pick(fields, "sender", default=sender)
    if not sender:
        raise ValueError("Envelope.sender is required")
    performative = _pick(fields, "performative", default=performative)
    if performative not in PERFORMATIVES:
        raise ValueError(f"Unknown performative: {performative}")
    trace_id = _pick(fields, "traceId", "trace_id", default=trace_id)
    if not trace_id:
        raise ValueError("Envelope.traceId is required")

    return {
        "msgId": uid("MSG"),
        "sender": sender,
        "receiver": _pick(fields, "receiver", default=receiver),
        "performative": performative,
        "inReplyTo": _pick(fields, "inReplyTo", "in_reply_to", default=in_reply_to),
        "priority": _pick(fields, "priority", default=priority),
        "content": _pick(fields, "content", default=content if content is not None else {}),
        "traceId": trace_id,
        "createdAt": now_ms(),
        "meta": _pick(fields, "meta", default=meta if meta is not None else {}),
    }


def validate_envelope(env):
    if not isinstance(env, dict):
        return False
    if not env.get("msgId") or not env.get("sender") or not env.get("traceId"):
        return False
    if env.get("performative") not in PERFORMATIVES:
        return False
    return True
