from __future__ import annotations

import math
from datetime import datetime, timezone
from decimal import Decimal

from .envelope import create_envelope
from .util import now_ms, round_to, uid

__all__ = ["Actor", "SelectorAgent", "ControllerAgent", "SpeakerAgent", "AnalystAgent"]

_BID_REASONS = {
    "planning": "选品与排期模型命中度最高",
    "realtime": "流式意图分类实例空闲",
    "copy": "话术风格库与数字人指令完整",
    "attribution": "因果图与 A/B 引擎就绪",
}

_PLAN_ADVISORIES = {
    "selector": "建议保留礼盒作为低门槛入口，主推单品控制在两款以内",
    "controller": "建议第 3 分钟补价格锚点，12 分钟后再进入主推，避免开场信息过载",
    "speaker": "建议把参数讲解压到 90 秒并插入冲泡演示，长段口播会掉停留",
    "analyst": "建议把发券放到讲解完成之后，保留 A/B 对照样本",
}

_ACTION_MAP = {
    "authenticity_doubt": {
        "action": "pause_push_and_reply",
        "label": "暂停逼单并启动信任修复",
        "risk": "high",
        "requiresConsensus": True,
    },
    "negative_feedback": {
        "action": "acknowledge_and_reply",
        "label": "承接负面反馈并降速",
        "risk": "high",
        "requiresConsensus": True,
    },
    "compliance_probe": {
        "action": "compliant_reply",
        "label": "触发合规改写后回应",
        "risk": "high",
        "requiresConsensus": False,
    },
    "price_objection": {
        "action": "objection_reply",
        "label": "化解价格异议",
        "risk": "medium",
        "requiresConsensus": False,
    },
    "purchase_intent": {
        "action": "guide_cart",
        "label": "承接购买意图并指路",
        "risk": "low",
        "requiresConsensus": False,
    },
    "product_question": {
        "action": "answer_product",
        "label": "回答商品问题",
        "risk": "low",
        "requiresConsensus": False,
    },
    "churn_signal": {
        "action": "reengage",
        "label": "挽回流失信号",
        "risk": "medium",
        "requiresConsensus": False,
    },
    "low_value": {
        "action": "ignore_low_value",
        "label": "低价值弹幕降级",
        "risk": "low",
        "requiresConsensus": False,
    },
}

_DEFAULT_ACTION = {
    "action": "soft_engage",
    "label": "轻量互动承接",
    "risk": "low",
    "requiresConsensus": False,
}


def _merge(options, kwargs) -> dict:
    merged: dict = {}
    if isinstance(options, dict):
        merged.update(options)
    merged.update(kwargs)
    return merged


def _read(target, *names, default=None):
    if target is None:
        return default
    for name in names:
        if isinstance(target, dict):
            value = target.get(name)
        else:
            value = getattr(target, name, None)
        if value is not None:
            return value
    return default


def _text(value) -> str:
    return "" if value is None else str(value)


def _js_round(value) -> int:
    return int(math.floor(float(value) + 0.5))


def _to_fixed(value, digits: int = 0) -> str:
    if value is None:
        return "NaN"
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    negative = value < 0
    scaled = Decimal(abs(value)).scaleb(digits)
    count = int(math.floor(scaled + Decimal("0.5")))
    quantum = 10**digits
    whole, frac = divmod(count, quantum)
    body = f"{whole}.{frac:0{digits}d}" if digits else str(whole)
    return f"-{body}" if negative else body


def _to_locale_string(value) -> str:
    if value is None:
        return ""
    number = float(value)
    if number.is_integer():
        return f"{int(number):,}"
    return f"{number:,.3f}".rstrip("0").rstrip(".")


def _js_number(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    number = float(value)
    if number.is_integer() and abs(number) < 1e21:
        return str(int(number))
    return repr(number)


def _iso_now() -> str:
    moment = datetime.now(timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"


def _join_reasons(reasons) -> str:
    items = list(reasons or [])
    return "；".join(_text(item) for item in items)


def _first(items):
    rows = list(items or [])
    return rows[0] if rows else None


class Actor:
    def __init__(self, options=None, **kwargs):
        merged = _merge(options, kwargs)
        self.id = merged.get("id")
        self.logicalRole = _read(merged, "logicalRole", "logical_role")
        self.name = merged.get("name")
        self.title = merged.get("title")
        self.latin = merged.get("latin")
        self.description = merged.get("description")
        self.accent = merged.get("accent")
        self.capabilities = merged.get("capabilities")
        self.weight = merged.get("weight")
        self.cognition = merged.get("cognition")
        self.tools = merged.get("tools") if merged.get("tools") is not None else []
        self.runtime = merged.get("runtime")
        self.bus = merged.get("bus")
        self.canBid = bool(_read(merged, "canBid", "can_bid", default=True))
        self.replicaOf = _read(merged, "replicaOf", "replica_of")
        standby = bool(merged.get("standby"))
        self.status = "standby" if standby else "active"
        self.mailbox: list = []
        self.processing = False
        self.load = 0.12
        self.reliability = 0.95 if self.replicaOf else 0.97
        self.handled = 0
        self.received = 0
        self.lastEnvelope = None
        self.lastAction = "热备待命" if standby else "等待任务"
        self.lastActionAt = None
        self.recentEnvelopes: list = []
        self.currentTask = None

    def enqueue(self, envelope):
        self.received += 1
        self.lastEnvelope = envelope
        self.mailbox.append(envelope)
        if len(self.mailbox) > 80:
            self.mailbox.pop(0)
        self.load = min(0.92, 0.16 + len(self.mailbox) * 0.09)
        self.runtime.emit("agent", self.snapshot())
        self.drain()

    def drain(self):
        if self.processing or self.status != "active":
            return None
        self.processing = True
        self.load = max(self.load, 0.38)
        while self.mailbox and self.status == "active":
            envelope = self.mailbox.pop(0)
            try:
                self.handle(envelope)
            except Exception as error:
                self.runtime.emit(
                    "agent.error",
                    {
                        "agent": self.id,
                        "message": str(error),
                        "traceId": _read(envelope, "traceId", "trace_id"),
                    },
                )
            self.handled += 1
            self.load = max(0.12, min(0.9, 0.2 + len(self.mailbox) * 0.1))
            self.runtime.emit("agent", self.snapshot())
        self.processing = False
        self.load = 0.12
        return None

    def handle(self, envelope):
        content = _read(envelope, "content")
        current = _read(content, "capability", "kind", default="message")
        self.currentTask = f"{_read(envelope, 'performative')} · {current}"
        entry = {
            "performative": _read(envelope, "performative"),
            "from": _read(envelope, "sender"),
            "at": _read(envelope, "createdAt", "created_at"),
            "traceId": _read(envelope, "traceId", "trace_id"),
        }
        self.recentEnvelopes = ([entry] + list(self.recentEnvelopes))[:6]
        performative = _read(envelope, "performative")
        if performative == "CFP":
            return self.onCfp(envelope)
        if performative == "AWARD":
            return self.onAward(envelope)
        if performative == "VOTE":
            return self.onVote(envelope)
        if performative == "REQUEST":
            return self.onRequest(envelope)
        if performative == "INFORM":
            return self.onInform(envelope)
        return None

    def onCfp(self, envelope):
        if not self.canBid:
            return None
        content = _read(envelope, "content")
        capability = _read(content, "capability", default="general")
        capability_score = _read(self.capabilities, capability, default=0.2)
        score = round_to(capability_score * 0.62 + (1 - self.load) * 0.23 + self.reliability * 0.15, 4)
        self.lastAction = f"投标 {capability} · 评分 {_js_number(score)}"
        self.lastActionAt = now_ms()
        return self.bus.send(
            create_envelope(
                {
                    "sender": self.id,
                    "receiver": _read(envelope, "sender"),
                    "performative": "PROPOSE",
                    "traceId": _read(envelope, "traceId", "trace_id"),
                    "inReplyTo": _read(envelope, "msgId", "msg_id"),
                    "content": {
                        "capability": capability,
                        "task": _read(content, "task"),
                        "score": score,
                        "breakdown": {
                            "capability": round_to(capability_score, 3),
                            "availability": round_to(1 - self.load, 3),
                            "reliability": self.reliability,
                        },
                        "load": round_to(self.load, 3),
                        "etaMs": _js_round(180 + self.load * 420),
                        "reason": self.bidReason(capability),
                    },
                }
            )
        )

    def bidReason(self, capability):
        return _read(_BID_REASONS, capability, default="通用能力可用")

    def onAward(self, envelope):
        content = _read(envelope, "content")
        task = _read(content, "task", default="任务")
        self.lastAction = f"中标：{task}"
        self.lastActionAt = now_ms()
        self.currentTask = _read(content, "task")
        self.runtime.emit("agent", self.snapshot())
        return None

    def evaluateProposal(self, proposal):
        evidence_count = len(_read(proposal, "evidence", default=[]))
        impact = _read(proposal, "expectedImpact", "expected_impact", default=0)
        approve = evidence_count >= 2 and impact >= 0
        rationale = (
            f"证据 {evidence_count} 条，预期增益 {_to_fixed(impact * 100, 1)}pp，风险可控"
            if approve
            else "证据不足或预期增益为负，选择否决"
        )
        return {"approve": approve, "rationale": rationale}

    def onVote(self, envelope):
        content = _read(envelope, "content")
        proposal = _read(content, "proposal", default={})
        evaluation = self.evaluateProposal(proposal)
        self.lastAction = f"投票：{'赞成' if evaluation['approve'] else '否决'}"
        self.lastActionAt = now_ms()
        return self.bus.send(
            create_envelope(
                {
                    "sender": self.id,
                    "receiver": _read(envelope, "sender"),
                    "performative": "VOTE",
                    "traceId": _read(envelope, "traceId", "trace_id"),
                    "inReplyTo": _read(envelope, "msgId", "msg_id"),
                    "content": {
                        "proposalId": _read(proposal, "id"),
                        "approve": evaluation["approve"],
                        "weight": self.weight,
                        "rationale": evaluation["rationale"],
                    },
                }
            )
        )

    def onRequest(self, envelope):
        content = _read(envelope, "content")
        if _read(content, "kind") != "plan.review":
            return None
        self.lastAction = "提交方案评审意见"
        self.lastActionAt = now_ms()
        return self.bus.send(
            create_envelope(
                {
                    "sender": self.id,
                    "receiver": _read(envelope, "sender"),
                    "performative": "INFORM",
                    "traceId": _read(envelope, "traceId", "trace_id"),
                    "inReplyTo": _read(envelope, "msgId", "msg_id"),
                    "content": {
                        "kind": "plan.advisory",
                        "advisory": _read(_PLAN_ADVISORIES, self.logicalRole, default="无补充意见"),
                    },
                }
            )
        )

    def onInform(self, envelope):
        content = _read(envelope, "content")
        if _read(content, "kind") == "plan.published":
            self.lastAction = "接收直播方案"
            self.lastActionAt = now_ms()
        return None

    def setStatus(self, status):
        self.status = status
        self.load = 0.12 if status == "active" else 0
        if status == "standby":
            self.lastAction = "热备待命"
        if status == "offline":
            self.lastAction = "实例已下线"
        self.runtime.emit("agent", self.snapshot())

    def snapshot(self):
        return {
            "id": self.id,
            "logicalRole": self.logicalRole,
            "name": self.name,
            "title": self.title,
            "latin": self.latin,
            "description": self.description,
            "accent": self.accent,
            "status": self.status,
            "load": round_to(self.load, 3),
            "reliability": self.reliability,
            "handled": self.handled,
            "received": self.received,
            "mailbox": len(self.mailbox),
            "capabilities": self.capabilities,
            "weight": self.weight,
            "cognition": self.cognition,
            "tools": self.tools,
            "lastAction": self.lastAction,
            "lastActionAt": self.lastActionAt,
            "currentTask": self.currentTask,
            "replicaOf": self.replicaOf,
            "recentEnvelopes": self.recentEnvelopes,
            "workingMemory": self.runtime.memory.get_working(self.id, 4),
        }


class SelectorAgent(Actor):
    def buildPlan(self, goal, trace):
        tracer = self.runtime.tracer
        registry = self.runtime.registry
        session_config = _read(_read(self.runtime, "config"), "session")
        self.lastAction = "执行 Plan-Execute：生成直播方案"
        self.lastActionAt = now_ms()
        self.runtime.emit("agent", self.snapshot())

        memory = tracer.track(
            trace,
            "memory.recall",
            self.id,
            lambda: registry.call(
                "memory.recall",
                {"query": goal, "limit": 3},
                {"traceId": _read(trace, "id")},
            ),
        )
        ranked = tracer.track(
            trace,
            "catalog.rank",
            self.id,
            lambda: registry.call("catalog.rank", {"limit": 4}, {"traceId": _read(trace, "id")}),
        )
        products = list(_read(_read(ranked, "result"), "products", default=[]))
        hero = _first(products)
        forecast = tracer.track(
            trace,
            "demand.forecast",
            self.id,
            lambda: registry.call(
                "demand.forecast",
                {"productId": _read(hero, "id")},
                {"traceId": _read(trace, "id")},
            ),
        )
        schedule = tracer.track(
            trace,
            "schedule.optimize",
            self.id,
            lambda: registry.call(
                "schedule.optimize",
                {
                    "durationMin": _read(session_config, "durationMin", "duration_min"),
                    "targetAov": 260,
                },
                {"traceId": _read(trace, "id")},
            ),
        )
        offer = tracer.track(
            trace,
            "offer.simulate",
            self.id,
            lambda: registry.call(
                "offer.simulate",
                {
                    "targetGmv": _read(session_config, "targetGmv", "target_gmv"),
                    "aov": 260,
                },
                {"traceId": _read(trace, "id")},
            ),
        )

        segments = list(_read(_read(schedule, "result"), "segments", default=[]))
        scripts: list = []
        for product in products[:3]:
            product_id = _read(product, "id")
            segment = next(
                (row for row in segments if product_id in (_read(row, "products", default=[]) or [])),
                None,
            )
            if segment is None:
                segment = segments[1] if len(segments) > 1 else None
            payload = {
                "intent": "plan",
                "productId": product_id,
                "style": _read(segment, "style"),
                "stage": _read(segment, "context"),
                "reason": "直播前方案话术初稿",
            }
            script = tracer.track(
                trace,
                f"script.compose:{product_id}",
                self.id,
                lambda compose_args=payload: registry.call(
                    "script.compose", compose_args, {"traceId": _read(trace, "id")}
                ),
            )
            script_result = _read(script, "result", default={})
            scripts.append(
                {
                    "productId": product_id,
                    "productName": _read(product, "name"),
                    "segment": _read(segment, "label"),
                    "style": _read(script_result, "style"),
                    "text": _read(script_result, "finalText", "final_text"),
                    "guardrail": _read(script_result, "guardrail"),
                }
            )

        memory_result = _read(memory, "result", default={})
        memory_hits = _read(memory_result, "hits", default=[])
        narrative = self.runtime.llm.plan(goal, products, memory_hits)
        plan = {
            "id": uid("PLAN"),
            "sessionId": _read(_read(self.runtime, "session"), "id"),
            "title": _read(session_config, "title"),
            "goal": goal,
            "version": "v1.0",
            "createdAt": now_ms(),
            "products": products,
            "forecast": _read(forecast, "result", default={}),
            "segments": segments,
            "offers": _read(offer, "result", default={}),
            "scripts": scripts,
            "narrative": narrative,
            "memoryHits": memory_hits,
            "toolTrace": [
                {
                    "name": _read(span, "name"),
                    "agent": _read(span, "agent"),
                    "durationMs": _read(span, "durationMs", "duration_ms"),
                }
                for span in (_read(trace, "spans", default=[]) or [])
            ],
            "status": "draft",
        }
        self.runtime.memory.push_working(
            self.id,
            {"kind": "plan", "planId": plan["id"], "summary": _read(narrative, "headline")},
        )
        self.lastAction = f"方案 v1.0 已生成 · {len(products)} 个商品"
        self.lastActionAt = now_ms()
        self.runtime.emit("agent", self.snapshot())
        return plan

    def revisePlan(self, plan, advisories):
        advisory_list = list(advisories or [])
        narrative = dict(_read(plan, "narrative", default={}) or {})
        revised = {
            **plan,
            "version": "v1.1",
            "advisories": advisory_list,
            "narrative": {
                **narrative,
                "rationale": (
                    f"{_text(_read(narrative, 'rationale'))} 三方评审补充："
                    f"{len(advisory_list)} 条节奏建议已并入。"
                ),
            },
            "status": "ready",
        }
        segments = revised.get("segments") or []
        if segments and segments[0]:
            segments[0]["goal"] = "承接自然流量，第 3 分钟给出价格锚点"
        scripts = revised.get("scripts") or []
        demo_script = scripts[0] if scripts else None
        if demo_script:
            demo_script["text"] = f"{_text(demo_script.get('text'))} 接下来我会现场冲一泡，先看汤色，再讲参数。"
            demo_script["revisedBy"] = "三方评审"
        self.lastAction = f"方案 {revised['version']} 已定稿 · 合并 {len(advisory_list)} 条评审意见"
        self.lastActionAt = now_ms()
        self.runtime.emit("agent", self.snapshot())
        return revised


class ControllerAgent(Actor):
    def observe(self, text, meta=None, trace=None):
        meta = meta if meta is not None else {}
        registry = self.runtime.registry
        tracer = self.runtime.tracer

        def run(name, fn):
            if trace is not None:
                return tracer.track(trace, name, self.id, fn)
            return fn()

        classification_result = run(
            "danmaku.classify",
            lambda: registry.call(
                "danmaku.classify",
                {"text": text},
                {"traceId": _read(meta, "traceId", "trace_id"), "silent": True},
            ),
        )
        classification = _read(classification_result, "result", default={})
        extra = None
        if _read(classification, "risk") == "high":
            extra = run(
                "sentiment.analyze",
                lambda: registry.call(
                    "sentiment.analyze",
                    {"text": text},
                    {"traceId": _read(meta, "traceId", "trace_id"), "silent": True},
                ),
            )
        if _read(classification, "intent") == "product_question" and _read(classification, "productId", "product_id"):
            run(
                "inventory.check",
                lambda: registry.call(
                    "inventory.check",
                    {"productId": _read(classification, "productId", "product_id")},
                    {"traceId": _read(meta, "traceId", "trace_id"), "silent": True},
                ),
            )
        if trace is not None:
            handle = tracer.span(
                trace,
                "decision.route",
                self.id,
                {
                    "intent": _read(classification, "intent"),
                    "risk": _read(classification, "risk"),
                },
            )
            handle["end"]("ok")

        intent = _read(classification, "intent")
        decision = dict(_ACTION_MAP[intent] if intent in _ACTION_MAP else _DEFAULT_ACTION)

        sentiment = _read(classification, "sentiment", default=0)
        thought = {
            "observation": text,
            "intent": intent,
            "sentiment": sentiment,
            "reasoning": (
                f"{_join_reasons(_read(classification, 'reasons'))}。情绪 {_to_fixed(sentiment, 2)}，"
                f"选择「{decision['label']}」。"
            ),
            "reActSteps": [
                {"step": "thought", "value": "先判定意图与风险，再决定是否调用工具"},
                {"step": "action", "value": "调用 danmaku.classify / sentiment.analyze"},
                {
                    "step": "observation",
                    "value": f"意图 {_text(intent)} · 情绪 {_js_number(sentiment)}",
                },
                {"step": "final", "value": decision["label"]},
            ],
        }

        self.runtime.memory.push_working(
            self.id,
            {
                "kind": "danmaku",
                "text": _text(text)[:60],
                "intent": intent,
                "action": decision["action"],
            },
        )
        self.lastAction = f"{decision['label']} · {_text(intent)}"
        self.lastActionAt = now_ms()
        self.runtime.emit("agent", self.snapshot())

        # 用户画像路由：Controller 负责识别用户特征（新老客/时段/价格敏感度）
        user = _read(_read(meta, "item"), "user")
        profile = None
        if user:
            self.runtime.userProfile.record_interaction(
                user, intent=intent, sentiment=sentiment, text=text
            )
            profile = self.runtime.userProfile.route(user)
            if trace is not None:
                span = tracer.span(
                    trace, "profile.route", self.id,
                    {
                        "user": user,
                        "segment": profile.get("segment"),
                        "isNew": profile.get("isNew"),
                        "priceTier": profile.get("priceTier"),
                        "preferredStyle": profile.get("preferredStyle"),
                    },
                )
                span["end"]("ok")

        return {
            "classification": classification,
            "extra": _read(extra, "result") if extra is not None else None,
            "thought": thought,
            "decision": decision,
            "meta": meta,
            "profile": profile,
        }


class SpeakerAgent(Actor):
    def respond(self, options=None, **kwargs):
        merged = _merge(options, kwargs)
        classification = merged.get("classification")
        intent = merged.get("intent")
        style = merged.get("style")
        profile = merged.get("profile") or {}
        if style is None:
            style = profile.get("preferredStyle")
        stage = merged.get("stage")
        trace_id = _read(merged, "traceId", "trace_id")
        reason = merged.get("reason")
        trace = merged.get("trace")

        registry = self.runtime.registry
        tracer = self.runtime.tracer

        def run(name, fn):
            if trace is not None:
                return tracer.track(trace, name, self.id, fn)
            return fn()

        product_id = _read(classification, "productId", "product_id")
        if product_id is None:
            plan = _read(_read(self.runtime, "session"), "plan")
            products = _read(plan, "products", default=[]) or []
            product_id = _read(_first(products), "id")
        if product_id is None:
            product_id = "P-01"

        resolved_intent = intent
        if resolved_intent is None:
            resolved_intent = _read(classification, "intent", default="normal")
        resolved_reason = reason
        if resolved_reason is None:
            reasons = _read(classification, "reasons")
            if reasons is not None:
                resolved_reason = _join_reasons(reasons)

        script = run(
            "script.compose",
            lambda: registry.call(
                "script.compose",
                {
                    "intent": resolved_intent,
                    "productId": product_id,
                    "style": style,
                    "stage": stage,
                    "reason": resolved_reason,
                },
                {"traceId": trace_id, "silent": True},
            ),
        )
        script_result = _read(script, "result", default={})
        digital = run(
            "digital_human.direct",
            lambda: registry.call(
                "digital_human.direct",
                {
                    "script": _read(script_result, "finalText", "final_text"),
                    "emotion": _read(script_result, "emotion"),
                },
                {"traceId": trace_id, "silent": True},
            ),
        )

        final_text = _text(_read(script_result, "finalText", "final_text"))
        self.runtime.memory.push_working(
            self.id,
            {
                "kind": "script",
                "style": _read(script_result, "style"),
                "productId": product_id,
                "summary": final_text[:50],
            },
        )
        self.lastAction = f"生成「{_text(_read(script_result, 'style'))}」话术"
        self.lastActionAt = now_ms()
        self.runtime.emit("agent", self.snapshot())

        return {
            "script": final_text,
            "rawScript": _read(script_result, "text"),
            "style": _read(script_result, "style"),
            "styleSource": _read(script_result, "styleSource", "style_source"),
            "emotion": _read(script_result, "emotion"),
            "gesture": _read(script_result, "gesture"),
            "guardrail": _read(script_result, "guardrail"),
            "digitalHuman": _read(digital, "result", default={}),
            "productId": product_id,
        }


class AnalystAgent(Actor):
    def review(self, session, trace, metrics):
        registry = self.runtime.registry
        tracer = self.runtime.tracer
        config = _read(self.runtime, "config")
        title = _read(_read(config, "session"), "title")
        coupon = _read(self.runtime, "coupon")
        incident = _read(self.runtime, "incident")

        causal = tracer.track(
            trace,
            "causal.attribution",
            self.id,
            lambda: registry.call(
                "causal.attribution",
                {
                    "intervention": _read(coupon, "label", default="第 52 分钟发放 ¥15 无门槛券"),
                },
                {"traceId": _read(trace, "id"), "silent": True},
            ),
        )
        causal_result = _read(causal, "result", default={})

        interventions: list = []
        if coupon:
            interventions.append(f"发放{_text(_read(coupon, 'label'))}")
        if incident:
            interventions.append(f"处置舆情事件 {_text(_read(incident, 'id'))}")
        if not interventions:
            interventions.append("自然节奏下的常规讲解")

        memory = tracer.track(
            trace,
            "memory.recall",
            self.id,
            lambda: registry.call(
                "memory.recall",
                {"query": f"{_text(title)} {' '.join(interventions)}", "limit": 3},
                {"traceId": _read(trace, "id"), "silent": True},
            ),
        )
        memory_result = _read(memory, "result", default={})

        reflect = self.runtime.llm.reflect(
            {
                "summary": {**dict(metrics or {}), "prepHint": "参数段仍需插入冲泡演示"},
                "causal": causal_result,
                "sentimentRecovery": (
                    {
                        "triggered": True,
                        "count": _read(incident, "count"),
                        "recoverySec": _read(incident, "recoverySec", "recovery_sec", default=14),
                    }
                    if incident
                    else {"triggered": False}
                ),
                "latency": {"p99": _read(metrics, "p99")},
            }
        )

        # 用本场真实响应更新赌博机：购买=1，负面=0，其余不更新。
        bandit_updates = 0
        responses = list(_read(session, "responses", default=[]) or [])[-40:]
        for response in responses:
            response_intent = _read(response, "intent")
            reward = None
            if response_intent == "purchase_intent":
                reward = 1
            elif response_intent in ("authenticity_doubt", "negative_feedback"):
                reward = 0
            if reward is None:
                continue
            updated = self.runtime.bandit.update(
                _read(response, "stage", default="讲解"),
                _read(response, "style"),
                reward,
            )
            if updated:
                bandit_updates += 1

        viewers = _read(metrics, "viewers", default=0)
        comments = _read(metrics, "comments", default=0)
        orders = _read(metrics, "orders", default=0)
        funnel = {
            "impressions": _js_round(viewers * 2.4),
            "stays": _js_round(viewers * 0.62),
            "interactions": _js_round(comments * 1.35),
            "addCart": _js_round(orders * 2.35),
            "orders": orders,
        }

        att = _read(causal_result, "att", default=0)
        summary = (
            f"本场共处理 {_text(comments)} 条弹幕，回应 {_text(_read(metrics, 'responses'))} 次，"
            f"P99 {_js_number(_read(metrics, 'p99'))}ms。"
        )
        summary += "舆情事件已按共识流程处置。" if incident else "未触发高风险事件。"
        if coupon:
            summary += f"发券干预估计带来 {_to_fixed(att * 100, 2)}pp 转化增益。"

        lessons = _read(reflect, "lessons", default=[]) or []
        tags: list = []
        for response in _read(session, "responses", default=[]) or []:
            intent = _read(response, "intent")
            if intent not in tags:
                tags.append(intent)
            if len(tags) >= 6:
                break

        report = {
            "id": uid("REV"),
            "sessionId": _read(session, "id"),
            "title": title,
            "generatedAt": _iso_now(),
            "stage": _read(session, "stage"),
            "summary": summary,
            "kpis": {
                "gmv": _read(metrics, "gmv"),
                "orders": orders,
                "cvr": _read(metrics, "cvr"),
                "interactionRate": _read(metrics, "interactionRate", "interaction_rate"),
                "aov": _read(metrics, "aov"),
                "peakViewers": _read(metrics, "peakViewers", "peak_viewers"),
                "prepMinutes": _read(self.runtime, "prepMinutes", "prep_minutes", default=0),
                "reviewMinutes": 1,
            },
            "causal": {
                **causal_result,
                "dag": self.runtime.causal.dag(interventions[0]),
            },
            "funnel": funnel,
            "interventions": interventions,
            "memoryHits": _read(memory_result, "hits", default=[]),
            "lessons": lessons,
            "reflexion": _read(reflect, "critique"),
            "nextActions": self.runtime.buildNextActions(lessons),
            "banditUpdates": bandit_updates,
            "latency": {
                "p50": _read(metrics, "p50"),
                "p95": _read(metrics, "p95"),
                "p99": _read(metrics, "p99"),
            },
            "simulation": True,
            "traceId": _read(trace, "id"),
        }

        gmv = _read(metrics, "gmv", default=0)
        cvr = _read(metrics, "cvr", default=0)
        self.runtime.memory.add_episode(
            {
                "sessionId": _read(session, "id"),
                "date": _iso_now()[:10],
                "title": title,
                "outcome": (
                    f"gmv {_to_locale_string(gmv)} / cvr {_to_fixed(cvr * 100, 1)}% / "
                    f"P99 {_js_number(_read(metrics, 'p99'))}ms"
                ),
                "text": report["summary"],
                "lessons": lessons,
                "tags": tags,
                "metrics": {"cvrLift": att, "p99": _read(metrics, "p99")},
            }
        )

        self.runtime.latestReview = report
        self.lastAction = f"完成因果复盘 · {len(lessons)} 条结论"
        self.lastActionAt = now_ms()
        self.runtime.emit("agent", self.snapshot())
        return report
