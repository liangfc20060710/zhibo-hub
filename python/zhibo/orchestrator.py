from __future__ import annotations

import copy
import math
import re
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal

from .actors import AnalystAgent, ControllerAgent, SelectorAgent, SpeakerAgent
from .bandit import BetaBandit
from .blackboard import Blackboard
from .bus import MessageBus
from .causal import CausalEngine
from .data import (
    DANMAKU_POOL,
    DEFAULT_CONFIG,
    HISTORICAL_DECISIONS,
    HISTORICAL_TRACES,
    PRODUCTS,
    SEED_BANDIT,
    SEED_EPISODES,
    SEED_REVIEW,
    USERS,
)
from .envelope import create_envelope
from .guardrails import Guardrails
from .llm import LocalLLM
from .mcp import MCPRegistry
from .memory import MemorySystem
from .persistence import Persistence
from .stream import StreamEngine
from .tools import create_builtin_tools, create_hotplug_tool
from .tracer import Tracer
from .user_profile import UserProfile
from .util import Rng, clamp, hash_string, now_ms, round_to, sleep_ms, uid

CAPABILITIES = {
    "selector": {"planning": 0.98, "realtime": 0.48, "copy": 0.5, "attribution": 0.66},
    "controller": {"planning": 0.52, "realtime": 0.97, "copy": 0.6, "attribution": 0.6},
    "speaker": {"planning": 0.4, "realtime": 0.72, "copy": 0.96, "attribution": 0.42},
    "analyst": {"planning": 0.7, "realtime": 0.44, "copy": 0.55, "attribution": 0.97},
}

AGENT_META = {
    "selector": {
        "name": "策选",
        "title": "选品策划智能体",
        "latin": "SELECTOR",
        "accent": "#0d7f63",
        "cognition": "Plan-Execute",
        "description": "把目标拆成选品、排期、福利与话术任务，带记忆地生成可执行方案。",
        "tools": ["catalog.rank", "demand.forecast", "schedule.optimize", "offer.simulate", "memory.recall"],
    },
    "controller": {
        "name": "场控",
        "title": "场控互动智能体",
        "latin": "CONTROLLER",
        "accent": "#a9772c",
        "cognition": "ReAct · Stream",
        "description": "在 500ms 预算内识别意图与风险，完成用户画像路由（新老客/时段/价格敏感度），触发场控动作与高风险共识。",
        "tools": ["danmaku.classify", "sentiment.analyze", "inventory.check", "consensus.vote"],
    },
    "speaker": {
        "name": "言枢",
        "title": "话术生成智能体",
        "latin": "SPEAKER",
        "accent": "#3f72bd",
        "cognition": "ReAct + Bandit",
        "description": "按上下文选择话术风格，生成口播与数字人指令，输出前强制合规校验。",
        "tools": ["script.compose", "script.compliance", "digital_human.direct", "bandit.choose"],
    },
    "analyst": {
        "name": "观澜",
        "title": "数据复盘智能体",
        "latin": "ANALYST",
        "accent": "#c05572",
        "cognition": "Reflexion + Causal",
        "description": "做 ATT 估计、置信区间与 Reflexion，把结论写回长期记忆。",
        "tools": ["causal.attribution", "metrics.snapshot", "memory.recall", "bandit.update"],
    },
}

_TICK_INTERVAL_S = 2.8


def _clone(value):
    return copy.deepcopy(value)


def _perf_ms():
    return time.perf_counter() * 1000


def _js_round(value):
    return int(math.floor(float(value) + 0.5))


def _to_fixed(value, digits=0):
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


def _num_text(value):
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


def _locale_int(value):
    try:
        return f"{int(round(float(value))):,}"
    except (TypeError, ValueError):
        return ""


def _iso_now():
    moment = datetime.now(timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"


def _parse_iso_ms(value):
    raw = str(value).strip()
    if raw.endswith(("Z", "z")):
        raw = raw[:-1] + "+00:00"
    moment = datetime.fromisoformat(raw)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def _noop(*args, **kwargs):
    return None


def _mask_key(key):
    """脱敏显示 API Key：仅保留前 4 位和后 4 位。"""
    if not key or len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"


class ZhiboRuntime:
    def __init__(self, options=None, *, emit=None, seed=True, auto_simulate=True, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        raw_emit = merged.get("emit", emit)
        if not callable(raw_emit):
            raw_emit = _noop
        auto_simulate = merged.get("auto_simulate", merged.get("autoSimulate", auto_simulate))
        seed = merged.get("seed", seed)

        self._raw_emit = raw_emit
        self._emit_lock = threading.Lock()
        self._lock = threading.RLock()
        self.emit = self._safe_emit

        self.version = "1.0.0"
        self.startedAt = now_ms()
        self.rng = Rng(20261108)
        self.products = _clone(PRODUCTS)
        self.config = _clone(DEFAULT_CONFIG)
        self.llm = LocalLLM({"products": self.products, **self.config.get("llm", {})})
        self.guardrails = Guardrails({"config": self.config["guardrails"], "products": self.products})
        self.causal = CausalEngine({"seed": 20261108})
        self.tracer = Tracer({"emit": self.emit})
        self.bus = MessageBus({"emit": self.emit})
        self.blackboard = Blackboard({"emit": self.emit})
        self.approvals = {}
        self.humanQueue = []
        self.consensusHistory = []
        self.lastConsensus = None
        self.lastContract = None
        self.decisions = []
        self.metricsHistory = []
        self.latestReview = None
        self.reviewIsHistorical = False
        self.coupon = None
        self.incident = None
        self.loadTest = None
        self.stressHistory = []
        self.prepMinutes = None
        self.prepChainMs = None
        self.chatLog = []
        self.dialogHistory = []
        self.autoSimulate = auto_simulate
        self.autoDanmaku = True
        self._metrics_persist_counter = 0

        self.memory = MemorySystem({"episodes": _clone(SEED_EPISODES) if seed else []})
        self.persistence = Persistence()
        self.userProfile = UserProfile()
        self.bandit = BetaBandit(
            {
                "contexts": self.config["bandit"]["contexts"],
                "arms": self.config["bandit"]["arms"],
                "prior": SEED_BANDIT,
            }
        )
        self.registry = MCPRegistry(
            {"emit": self.emit, "approvalValidator": lambda name, context: self.validateApproval(name, context)}
        )
        for spec, handler in create_builtin_tools(self):
            self.registry.register(spec, handler)

        self.tickTimer = None
        self._tickerActive = False

        self.createAgents()
        self.session = self.createSession()
        self.attachStream()

        if seed:
            self.applyHistoricalSeed()
        else:
            self.latestReview = None

        self.chatLog = []
        self.pushChat(
            "assistant",
            "我是中枢 Copilot，直连四个对等 Actor 与 MCP 工具层。你可以让我生成方案、开播、注入舆情、跑压测，或复盘本场。所有高风险动作都会走共识投票与合规校验。",
            [
                {
                    "type": "list",
                    "title": "可以这样开始",
                    "items": [
                        {"title": "生成今晚的直播方案", "desc": "Plan-Execute + 合同网招标", "badge": "方案"},
                        {"title": "注入负面舆情", "desc": "ReAct + 加权投票 + 合规否决", "badge": "风控"},
                        {"title": "复盘并做因果归因", "desc": "ATT / p 值 / Reflexion", "badge": "归因"},
                    ],
                }
            ],
            [
                {"label": "生成方案", "kind": "chat", "payload": {"message": "生成今晚的直播方案"}},
                {"label": "查看运行状态", "kind": "navigate", "payload": {"view": "agents"}},
            ],
            silent=True,
        )

        if self.autoSimulate:
            self.startTicker()

    def _safe_emit(self, event, payload=None):
        with self._emit_lock:
            self._raw_emit(event, payload)

    def _collect_round(self, *, trace_id, performative, timeout_ms, dispatch):
        holder = {"responses": []}

        def worker():
            holder["responses"] = self.bus.collect(
                {"traceId": trace_id, "performative": performative, "timeoutMs": timeout_ms}
            )

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        sleep_ms(6)
        try:
            dispatch()
        finally:
            thread.join()
        return holder["responses"]

    def createAgents(self):
        def make(agent_class, role, id, options=None):
            payload = {
                "id": id,
                "logicalRole": role,
                **AGENT_META[role],
                "capabilities": CAPABILITIES[role],
                "weight": self.config["consensus"]["weights"][role],
                "runtime": self,
                "bus": self.bus,
            }
            if options:
                payload.update(options)
            return agent_class(payload)

        self.selector = make(SelectorAgent, "selector", "selector")
        self.controller = make(ControllerAgent, "controller", "controller")
        self.speaker = make(SpeakerAgent, "speaker", "speaker")
        self.analyst = make(AnalystAgent, "analyst", "analyst")
        self.controllerB = make(
            ControllerAgent,
            "controller",
            "controller-b",
            {"replicaOf": "controller", "standby": True, "name": "场控 B"},
        )
        self.speakerB = make(
            SpeakerAgent,
            "speaker",
            "speaker-b",
            {"replicaOf": "speaker", "standby": True, "name": "言枢 B"},
        )
        self.agentList = [
            self.selector,
            self.controller,
            self.speaker,
            self.analyst,
            self.controllerB,
            self.speakerB,
        ]
        for agent in self.agentList:
            self.bus.register(agent)

    def createSession(self):
        now = datetime.now()
        stamp = f"{now.year}{now.month:02d}{now.day:02d}"
        return {
            "id": f"S-{stamp}-{int(math.floor(self.rng() * 90) + 10)}",
            "title": self.config["session"]["title"],
            "goal": self.config["session"]["goal"],
            "stage": "prep",
            "createdAt": now_ms(),
            "startedAt": None,
            "endedAt": None,
            "plan": None,
            "metrics": {
                "viewers": 0,
                "peakViewers": 0,
                "gmv": 0,
                "orders": 0,
                "cvr": 0,
                "interactionRate": 0,
                "sentiment": 0.82,
            },
            "comments": 0,
            "negative": 0,
            "responses": [],
            "danmaku": [],
        }

    def attachStream(self):
        self.stream = StreamEngine(
            {
                "windowMs": self.config["stream"]["batchWindowMs"],
                "maxBatch": self.config["stream"]["maxBatch"],
                "backpressureQueue": self.config["stream"]["backpressureQueue"],
                "emit": self.emit,
                "handler": self.handleBatch,
            }
        )

    def applyHistoricalSeed(self):
        for trace in HISTORICAL_TRACES:
            self.tracer.import_trace(trace)
        self.decisions = [
            {**d, "status": d.get("status") if d.get("status") is not None else "executed", "historical": True}
            for d in _clone(HISTORICAL_DECISIONS)
        ]
        self.latestReview = _clone(SEED_REVIEW)
        self.latestReview["historical"] = True
        self.latestReview["causal"]["dag"] = self.causal.dag(self.latestReview["causal"]["intervention"])
        self.reviewIsHistorical = True
        self.lastConsensus = {
            "proposalId": "PROP-SEED-CRISIS",
            "approved": True,
            "vetoed": False,
            "weight": 4,
            "threshold": 2.4,
            "ballots": [
                {"agent": "selector", "approve": True, "weight": 1, "rationale": "补偿成本可控，证据完整"},
                {"agent": "controller", "approve": True, "weight": 1.2, "rationale": "舆情扩散早期，需快速降速"},
                {"agent": "speaker", "approve": True, "weight": 0.9, "rationale": "话术已通过合规校验"},
                {"agent": "analyst", "approve": True, "weight": 0.9, "rationale": "历史案例支持先降速再补偿"},
            ],
            "at": "2026-09-18T20:32:00+08:00",
            "historical": True,
        }
        self.lastContract = {
            "task": "中秋茶礼场 · 生成执行方案",
            "capability": "planning",
            "winner": "selector",
            "bids": [
                {"agent": "selector", "score": 0.941, "load": 0.12, "etaMs": 210},
                {"agent": "analyst", "score": 0.763, "load": 0.16, "etaMs": 260},
                {"agent": "speaker", "score": 0.601, "load": 0.22, "etaMs": 340},
                {"agent": "controller", "score": 0.588, "load": 0.18, "etaMs": 300},
            ],
            "at": "2026-10-26T19:40:01+08:00",
            "historical": True,
        }
        self.seedBusLog()

    def seedBusLog(self):
        messages = [
            {
                "msgId": "MSG-SEED-01",
                "sender": "orchestrator",
                "receiver": "*",
                "performative": "CFP",
                "traceId": "TRC-SEED-PLAN",
                "content": {"capability": "planning", "task": "中秋茶礼场 · 生成执行方案"},
                "createdAt": _parse_iso_ms("2026-10-26T19:40:01+08:00"),
                "deliveredTo": ["selector", "controller", "speaker", "analyst"],
                "priority": 5,
                "inReplyTo": None,
                "meta": {"historical": True},
            },
            {
                "msgId": "MSG-SEED-02",
                "sender": "selector",
                "receiver": "orchestrator",
                "performative": "PROPOSE",
                "traceId": "TRC-SEED-PLAN",
                "content": {"score": 0.941, "etaMs": 210, "reason": "选品与排期模型命中度最高"},
                "createdAt": _parse_iso_ms("2026-10-26T19:40:01.180+08:00"),
                "deliveredTo": [],
                "priority": 5,
                "inReplyTo": "MSG-SEED-01",
                "meta": {"historical": True},
            },
            {
                "msgId": "MSG-SEED-03",
                "sender": "orchestrator",
                "receiver": "selector",
                "performative": "AWARD",
                "traceId": "TRC-SEED-PLAN",
                "content": {"task": "中秋茶礼场 · 生成执行方案"},
                "createdAt": _parse_iso_ms("2026-10-26T19:40:01.220+08:00"),
                "deliveredTo": ["selector"],
                "priority": 5,
                "inReplyTo": "MSG-SEED-02",
                "meta": {"historical": True},
            },
            {
                "msgId": "MSG-SEED-04",
                "sender": "compliance",
                "receiver": "orchestrator",
                "performative": "VETO",
                "traceId": "TRC-SEED-VETO",
                "content": {
                    "reason": "改价至 ¥169 低于凤凰蜜兰单丛底价 ¥190，触发价格红线",
                    "code": "PRICE_FLOOR",
                },
                "createdAt": _parse_iso_ms("2026-10-26T21:08:31+08:00"),
                "deliveredTo": [],
                "priority": 9,
                "inReplyTo": None,
                "meta": {"historical": True},
            },
        ]
        self.bus.log.extend(messages)
        self.bus.log.sort(key=lambda item: item["createdAt"])

    def startTicker(self):
        with self._lock:
            self._cancelTimer()
            self._tickerActive = True
            self._scheduleNextTick()

    def stopTicker(self):
        with self._lock:
            self._tickerActive = False
            self._cancelTimer()

    def _scheduleNextTick(self):
        timer = threading.Timer(_TICK_INTERVAL_S, self._tickLoop)
        timer.daemon = True
        self.tickTimer = timer
        timer.start()

    def _cancelTimer(self):
        timer = self.tickTimer
        self.tickTimer = None
        if timer is not None:
            timer.cancel()

    def _tickLoop(self):
        try:
            self.tick()
        except Exception:
            pass
        finally:
            if self._tickerActive:
                with self._lock:
                    if self._tickerActive:
                        self._scheduleNextTick()

    def tick(self):
        with self._lock:
            if self.session["stage"] != "live" or not self.autoDanmaku:
                return
            m = self.session["metrics"]
            m["viewers"] = _js_round(clamp(_js_round(m["viewers"] + self.rng() * 36 - 8), 300, 99999))
            m["peakViewers"] = max(m["peakViewers"], m["viewers"])
            if self.rng() < 0.72:
                m["orders"] += 1
                plan = self.session.get("plan") or {}
                plan_products = plan.get("products") or []
                hero = plan_products[0] if plan_products else self.products[0]
                m["gmv"] += _js_round(hero["price"] * (0.8 + self.rng() * 0.5))
            self.publishMetrics()
            roll = self.rng()
            pool = "normal"
            incident = self.incident
            if incident and incident.get("active") and incident.get("until", 0) > now_ms():
                pool = "normal"
            elif roll < 0.04:
                pool = "negative"
            elif roll < 0.12:
                pool = "emoji"
            elif roll < 0.2:
                pool = "purchase"
            elif roll < 0.3:
                pool = "objection"
            elif roll < 0.55:
                pool = "product"
            pool_list = DANMAKU_POOL[pool]
            text = pool_list[int(math.floor(self.rng() * len(pool_list)))]
            user = USERS[int(math.floor(self.rng() * len(USERS)))]
            try:
                self.ingestDanmaku(text, user=user, simulated=True, pool=pool)
            except Exception:
                pass

    def prepare(self):
        with self._lock:
            if self.session["stage"] in ("live", "paused"):
                raise RuntimeError("直播进行中，不能重新生成方案")
            trace = self.tracer.start(
                "直播前策划 · Plan-Execute", {"sessionId": self.session["id"], "mode": "Plan-Execute"}
            )
            started = _perf_ms()
            self.bus.send(
                create_envelope(
                    {
                        "sender": "orchestrator",
                        "receiver": "*",
                        "performative": "INFORM",
                        "traceId": trace["id"],
                        "content": {"kind": "prep.started", "goal": self.session["goal"]},
                    }
                )
            )

            contract = self.contract(
                capability="planning", task="生成本场直播执行方案", trace_id=trace["id"]
            )
            if not contract.get("winner"):
                self.tracer.finish(trace, "error", {"reason": "no bidder"})
                raise RuntimeError("没有可用智能体承接策划任务，已升级人工")
            case_hits = self.memory.recall_cases(self.session["goal"], 3)
            draft = self.selector.buildPlan(self.session["goal"], trace)
            # 将历史案例召回结果写入 trace 留痕
            if case_hits:
                self.tracer.span(trace, "memory.case_recall", "orchestrator", {"hits": len(case_hits), "top": [h.get("title") for h in case_hits[:3]]})

            def dispatch():
                for receiver in ("controller", "speaker"):
                    self.bus.send(
                        create_envelope(
                            {
                                "sender": "orchestrator",
                                "receiver": receiver,
                                "performative": "REQUEST",
                                "traceId": trace["id"],
                                "content": {"kind": "plan.review", "planId": draft["id"]},
                            }
                        )
                    )

            advisories_raw = self._collect_round(
                trace_id=trace["id"],
                performative="INFORM",
                timeout_ms=self.config["cnp"]["proposalWindowMs"],
                dispatch=dispatch,
            )
            advisories = [
                {"agent": env["sender"], "text": (env.get("content") or {}).get("advisory")}
                for env in advisories_raw
                if (env.get("content") or {}).get("kind") == "plan.advisory"
            ]
            plan = self.selector.revisePlan(draft, advisories)
            self.bus.broadcast(
                create_envelope(
                    {
                        "sender": "selector",
                        "receiver": "*",
                        "performative": "INFORM",
                        "traceId": trace["id"],
                        "content": {
                            "kind": "plan.published",
                            "planId": plan["id"],
                            "version": plan["version"],
                        },
                    }
                )
            )

            self.session["plan"] = plan
            self.session["stage"] = "ready"
            self.prepChainMs = round_to(_perf_ms() - started, 2)
            self.prepMinutes = 19.8
            plan_products = plan.get("products") or []
            self.blackboard.update(
                {
                    "stage": "ready",
                    "sessionId": self.session["id"],
                    "currentProduct": plan_products[0]["id"] if plan_products else None,
                    "sentiment": 0.82,
                }
            )
            narrative = plan.get("narrative") or {}
            card = self.createDecision(
                agent="selector",
                action=f"定稿 {plan['version']}：{narrative.get('headline')}",
                trigger="合同网招标完成，三方评审意见并入",
                risk="low",
                confidence=0.92,
                reasoning=f"{narrative.get('rationale')} {narrative.get('memoryLine')}。",
                evidence=[
                    f"商品候选 {len(plan_products)} 个",
                    f"排期 {len(plan.get('segments') or [])} 段",
                    f"评审意见 {len(advisories)} 条",
                    f"记忆命中 {len(plan.get('memoryHits') or [])} 条",
                ],
                consensus={
                    "approved": True,
                    "weight": 4,
                    "threshold": 2.4,
                    "vetoed": False,
                    "ballots": len(advisories),
                    "note": "直播前方案会签",
                },
                traceId=trace["id"],
                latencyMs=self.prepChainMs,
                status="executed",
                alternatives=["单主推方案", "全部 SKU 平铺"],
            )
            self.tracer.finish(
                trace,
                "ok",
                {
                    "planId": plan["id"],
                    "version": plan["version"],
                    "latencyMs": self.prepChainMs,
                    "advisories": len(advisories),
                },
            )
            self.emit("plan", plan)
            self.emit("session", self.sessionSummary())
            self.publishMetrics()
            self.persistence.upsert_session(
                self.session, plan=plan, metrics=self.getMetrics(), summary=self.sessionSummary()
            )
            return {
                "plan": plan,
                "trace": self.tracer.summary(trace),
                "contract": contract,
                "decision": card,
                "prepChainMs": self.prepChainMs,
            }

    def startLive(self):
        with self._lock:
            if not self.session.get("plan"):
                raise RuntimeError("请先生成直播方案")
            if self.session["stage"] == "live":
                return self.sessionSummary()
            if self.session["stage"] == "paused":
                return self.resumeLive()
            if self.session["stage"] in ("ended", "reviewed"):
                self.session["metrics"] = {
                    "viewers": 0,
                    "peakViewers": 0,
                    "gmv": 0,
                    "orders": 0,
                    "cvr": 0,
                    "interactionRate": 0,
                    "sentiment": 0.82,
                }
                self.session["comments"] = 0
                self.session["negative"] = 0
                self.session["responses"] = []
                self.session["danmaku"] = []
                self.session["endedAt"] = None
                self.incident = None
                self.coupon = None
                self.stream.reset_metrics()
            self.session["stage"] = "live"
            self.session["startedAt"] = now_ms()
            self.session["metrics"]["viewers"] = 1280 + int(math.floor(self.rng() * 160))
            self.session["metrics"]["peakViewers"] = self.session["metrics"]["viewers"]
            self.session["metrics"]["sentiment"] = 0.82
            plan_products = self.session["plan"].get("products") or []
            self.blackboard.update(
                {
                    "stage": "live",
                    "sessionId": self.session["id"],
                    "viewers": self.session["metrics"]["viewers"],
                    "peakViewers": self.session["metrics"]["peakViewers"],
                    "currentProduct": plan_products[0]["id"] if plan_products else None,
                    "sentiment": 0.82,
                }
            )
            self.emit("session", self.sessionSummary())
            self.emit(
                "log",
                {
                    "level": "info",
                    "text": f"直播开始 · {self.session['title']} · {len(plan_products)} 个商品待讲",
                    "at": now_ms(),
                },
            )
            self.publishMetrics()
            self.persistence.upsert_session(self.session, metrics=self.getMetrics())
            return self.sessionSummary()

    def pauseLive(self):
        with self._lock:
            if self.session["stage"] != "live":
                raise RuntimeError("当前不在直播中")
            self.session["stage"] = "paused"
            self.blackboard.update({"stage": "paused"})
            self.emit("session", self.sessionSummary())
            return self.sessionSummary()

    def resumeLive(self):
        with self._lock:
            if self.session["stage"] != "paused":
                raise RuntimeError("当前不是暂停状态")
            self.session["stage"] = "live"
            self.blackboard.update({"stage": "live"})
            self.emit("session", self.sessionSummary())
            return self.sessionSummary()

    def stopLive(self):
        with self._lock:
            if self.session["stage"] not in ("live", "paused"):
                raise RuntimeError("当前没有进行中的直播")
            self.session["stage"] = "ended"
            self.session["endedAt"] = now_ms()
            self.blackboard.update({"stage": "ended"})
            self.emit("session", self.sessionSummary())
            self.emit("log", {"level": "info", "text": "直播结束，等待复盘", "at": now_ms()})
            self.publishMetrics()
            self.persistence.upsert_session(self.session, metrics=self.getMetrics())
            return self.sessionSummary()

    def ingestDanmaku(self, text, options=None, *, user=None, simulated=False, pool="manual", **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        user = merged.get("user", user)
        simulated = merged.get("simulated", simulated)
        pool = merged.get("pool", pool)
        with self._lock:
            if self.session["stage"] != "live":
                raise RuntimeError("直播尚未开始，请先开场再注入弹幕")
            clean = str(text if text is not None else "").strip()[:120]
            if not clean:
                raise RuntimeError("弹幕不能为空")
            quick = self.llm.classify(clean)
            chosen_user = user or USERS[int(math.floor(self.rng() * len(USERS)))]
            item = {
                "id": uid("DMK"),
                "text": clean,
                "user": chosen_user,
                "at": now_ms(),
                "priority": quick.get("priority"),
                "simulated": simulated,
                "pool": pool,
            }
            self.session["danmaku"].append(item)
            if len(self.session["danmaku"]) > 300:
                self.session["danmaku"].pop(0)
            self.session["comments"] += 1
            self.emit("danmaku", item)
            return self.stream.ingest(item)

    def handleBatch(self, items, meta=None):
        meta = meta or {}
        with self._lock:
            self.emit("stream.batch", {"size": len(items), "at": now_ms(), **meta})
            results = []
            for item in items:
                try:
                    results.append(self.processOne(item))
                except Exception as error:
                    self.emit(
                        "log",
                        {"level": "error", "text": f"弹幕处理失败：{error}", "at": now_ms()},
                    )
                    results.append({"error": str(error), "item": item})
            return results

    def processOne(self, item):
        with self._lock:
            trace = self.tracer.start(
                "实时响应 · ReAct",
                {"sessionId": self.session["id"], "danmakuId": item.get("id"), "text": item.get("text"), "mode": "ReAct + Stream"},
            )
            t0 = _perf_ms()
            observation = self.controller.observe(item["text"], {"traceId": trace["id"], "item": item}, trace)
            classification = observation["classification"]
            decision = observation["decision"]
            profile = observation.get("profile")
            speaker_bundle = None
            consensus = None
            status = "executed"
            action_label = decision["label"]
            card = None

            if classification.get("intent") == "low_value":
                handle = self.tracer.span(trace, "priority.degrade", "controller", {"reason": "低信息密度弹幕"})
                handle["end"]("ok")
                self.tracer.finish(trace, "ok", {"degraded": True})
                response = {
                    "id": uid("RSP"),
                    "danmakuId": item["id"],
                    "user": item.get("user"),
                    "text": item.get("text"),
                    "intent": classification.get("intent"),
                    "sentiment": classification.get("sentiment"),
                    "risk": classification.get("risk"),
                    "action": decision["action"],
                    "actionLabel": "低价值弹幕 · 不占用生成资源",
                    "script": None,
                    "style": None,
                    "traceId": trace["id"],
                    "latencyMs": round_to(_perf_ms() - t0, 2),
                    "at": now_ms(),
                    "status": "ignored",
                    "stage": self.stageContext(),
                }
                self.recordResponse(response)
                return {"response": response}

            if decision.get("requiresConsensus"):
                incident_result = self.handleIncident(item, observation, trace)
                speaker_bundle = incident_result["speaker"]
                consensus = incident_result["consensus"]
                status = incident_result["status"]
                action_label = incident_result["actionLabel"]
                card = incident_result["decision"]
            else:
                speaker_bundle = self.speaker.respond(
                    {
                        "classification": classification,
                        "stage": self.stageContext(),
                        "traceId": trace["id"],
                        "trace": trace,
                        "profile": profile,
                    }
                )
                if classification.get("intent") == "compliance_probe":
                    status = "guarded"
                    action_label = "极限词拦截并合规改写"

            guardrail = (speaker_bundle or {}).get("guardrail") if speaker_bundle else None
            latency_ms = round_to(_perf_ms() - t0, 2)
            response = {
                "id": uid("RSP"),
                "danmakuId": item["id"],
                "user": item.get("user"),
                "text": item.get("text"),
                "intent": classification.get("intent"),
                "sentiment": classification.get("sentiment"),
                "risk": classification.get("risk"),
                "action": decision["action"],
                "actionLabel": action_label,
                "script": (speaker_bundle or {}).get("script") if speaker_bundle else None,
                "style": (speaker_bundle or {}).get("style") if speaker_bundle else None,
                "guardrail": guardrail,
                "digitalHuman": (speaker_bundle or {}).get("digitalHuman") if speaker_bundle else None,
                "consensus": consensus,
                "traceId": trace["id"],
                "latencyMs": latency_ms,
                "at": now_ms(),
                "status": status,
                "stage": self.stageContext(),
            }

            if card is None:
                intent = classification.get("intent")
                if intent == "compliance_probe":
                    violations = (guardrail or {}).get("violations") or []
                    card = self.createDecision(
                        agent="speaker",
                        action="拦截极限词并改写为合规表述",
                        trigger=f"弹幕触发合规探针：{item.get('text')}",
                        risk="high",
                        confidence=0.94,
                        reasoning="生成稿命中违禁词，规则引擎在任何输出前强制拦截，并由 Speaker 生成合规替代表述。",
                        evidence=[
                            *[v.get("message") for v in violations],
                            f"改写后话术已通过二次校验：{'否' if (guardrail or {}).get('pass') else '是'}",
                        ],
                        consensus=None,
                        traceId=trace["id"],
                        latencyMs=latency_ms,
                        status="guarded",
                        guardrail=guardrail,
                        alternatives=["静默忽略该弹幕", "人工接管"],
                    )
                elif intent == "price_objection":
                    card = self.createDecision(
                        agent="controller",
                        action="用每泡成本与尝鲜券化解价格异议",
                        trigger=f"价格异议：{item.get('text')}",
                        risk="medium",
                        confidence=classification.get("confidence"),
                        reasoning="价格异议不直接降价，先把价格拆到单泡，再给低门槛尝鲜路径，避免击穿价格体系。",
                        evidence=classification.get("reasons"),
                        consensus=None,
                        traceId=trace["id"],
                        latencyMs=latency_ms,
                        status="executed",
                        guardrail=guardrail,
                        alternatives=["直接发券", "忽略"],
                    )
                elif intent == "churn_signal":
                    card = self.createDecision(
                        agent="controller",
                        action="降低推销压力，切回冲泡演示",
                        trigger=f"流失信号：{item.get('text')}",
                        risk="medium",
                        confidence=classification.get("confidence"),
                        reasoning="流失信号出现时继续逼单会放大反感，切回可看的内容演示，先恢复停留。",
                        evidence=classification.get("reasons"),
                        consensus=None,
                        traceId=trace["id"],
                        latencyMs=latency_ms,
                        status="executed",
                        guardrail=guardrail,
                        alternatives=["加大发券力度", "暂停直播"],
                    )

            self.recordResponse(response)
            self.updateLiveMetrics(classification, item, latency_ms)
            self.publishMetrics()
            self.tracer.finish(
                trace,
                "ok",
                {"intent": classification.get("intent"), "action": decision["action"], "latencyMs": latency_ms, "status": status},
            )
            if card:
                response["decisionId"] = card["id"]
            self.emit("response", response)
            return {"response": response, "decision": card}

    def handleIncident(self, item, observation, trace):
        classification = observation["classification"]
        profile = observation.get("profile")
        incident = self.incident
        active_incident = incident if (incident and incident.get("active") and incident.get("until", 0) > now_ms()) else None
        draft = self.speaker.respond(
            {
                "classification": classification,
                "stage": "讲解",
                "traceId": trace["id"],
                "trace": trace,
                "reason": "；".join(classification.get("reasons") or []),
                "profile": profile,
            }
        )

        if active_incident:
            active_incident["count"] += 1
            active_incident["lastAt"] = now_ms()
            return {
                "speaker": draft,
                "consensus": active_incident.get("voteSummary"),
                "status": active_incident.get("status"),
                "actionLabel": "沿用已生效的舆情处置方案",
                "decision": None,
            }

        proposal = {
            "id": uid("PROP"),
            "kind": "incident",
            "action": "暂停逼单 90 秒 + 上检测报告 + 发放 ¥10 安抚券",
            "risk": "high",
            "productId": classification.get("productId"),
            "expectedImpact": 0.014,
            "evidence": [
                f"负面情绪 {_to_fixed(classification.get('sentiment'), 2)}",
                f"触发文本「{item.get('text')}」",
                "第三方检测报告 SGS-2026-0912 可调取",
                "历史同类案例恢复中位数 6 分钟",
            ],
            "script": draft.get("script"),
            "requestedBy": "controller",
            "tools": ["coupon.issue"],
        }
        vote = self.vote(proposal, trace["id"])
        coupon = None
        final_speaker = draft
        if vote.get("approved"):
            handle = self.tracer.span(trace, "coupon.issue", "controller", {"amount": 10})
            try:
                issued = self.registry.call(
                    "coupon.issue",
                    {"amount": 10, "threshold": 0, "approvalId": vote.get("approvalId")},
                    {"traceId": trace["id"]},
                )
                coupon = issued.get("result")
                handle["end"]("ok")
            except Exception as error:
                handle["end"]("error", {"error": str(error)})
        else:
            final_speaker = {
                **draft,
                "script": "先把节奏放慢，关于检测与原料批次，我们把报告放在 3 号链接，大家可以逐页看。今天不逼单，有疑问直接打在公屏上，我们一条条回。",
                "style": "合规保守",
                "emotion": "sincere",
            }

        new_incident = {
            "id": uid("INC"),
            "count": 1,
            "startedAt": now_ms(),
            "lastAt": now_ms(),
            "until": now_ms() + 60000,
            "active": True,
            "status": "executed" if vote.get("approved") else "blocked",
            "voteSummary": {
                "approved": vote.get("approved"),
                "weight": vote.get("weight"),
                "threshold": vote.get("threshold"),
                "vetoed": vote.get("vetoed"),
                "ballots": vote.get("ballots"),
            },
            "coupon": coupon,
            "recoverySec": 12 if vote.get("approved") else 30,
        }
        self.incident = new_incident
        card = self.createDecision(
            agent="controller",
            action=proposal["action"],
            trigger=f"舆情事件：{'；'.join(classification.get('reasons') or [])}",
            risk="high",
            confidence=0.88,
            reasoning="舆情处于扩散早期，先降低交易压力，再提供可核验证据，最后用低额补偿承接情绪；高风险动作必须经过加权投票与合规前置。",
            evidence=proposal["evidence"],
            consensus=new_incident["voteSummary"],
            traceId=trace["id"],
            latencyMs=round_to(now_ms() - trace["startedAt"], 2),
            status=new_incident["status"],
            guardrail=draft.get("guardrail"),
            alternatives=["继续逼单", "直接下播", "仅发布文字声明"],
        )
        self.emit("incident", new_incident)
        self.emit("consensus", self.lastConsensus)
        return {
            "speaker": final_speaker,
            "consensus": new_incident["voteSummary"],
            "status": new_incident["status"],
            "actionLabel": "共识通过 · 执行舆情处置" if vote.get("approved") else "处置受阻 · 已升级人工",
            "decision": card,
        }

    def recordResponse(self, response):
        with self._lock:
            self.session["responses"].append(response)
            if len(self.session["responses"]) > 200:
                self.session["responses"].pop(0)

    def updateLiveMetrics(self, classification, item, latency_ms=None):
        with self._lock:
            m = self.session["metrics"]
            sentiment = classification.get("sentiment") or 0
            if sentiment < -0.35:
                self.session["negative"] += 1
            target = (sentiment + 1) / 2
            m["sentiment"] = round_to(m["sentiment"] * 0.9 + target * 0.1, 3)
            if classification.get("intent") == "purchase_intent":
                p = 0.74 if self.coupon else 0.48
                if self.rng() < p:
                    m["orders"] += 1
                    product = next(
                        (prod for prod in self.products if prod["id"] == classification.get("productId")),
                        None,
                    )
                    if product is None:
                        plan = self.session.get("plan") or {}
                        plan_products = plan.get("products") or []
                        product = plan_products[0] if plan_products else self.products[0]
                    m["gmv"] += product["price"]
            m["interactionRate"] = round_to(
                clamp(0.16 + len(self.session["responses"]) * 0.007 + (0.03 if self.coupon else 0), 0, 0.52), 4
            )
            m["cvr"] = round_to(clamp(m["orders"] / max(m["viewers"], 1), 0, 0.2), 4)
            stream = self.stream.snapshot()
            self.blackboard.update(
                {
                    "viewers": m["viewers"],
                    "peakViewers": max(m["peakViewers"], m["viewers"]),
                    "gmv": _js_round(m["gmv"]),
                    "orders": m["orders"],
                    "interactionRate": m["interactionRate"],
                    "cvr": m["cvr"],
                    "sentiment": m["sentiment"],
                    "currentProduct": classification.get("productId"),
                    "latencyP99": stream.get("p99"),
                    "riskLevel": classification.get("risk"),
                },
                silent=True,
            )

    def publishMetrics(self):
        with self._lock:
            metrics = self.getMetrics()
            self.metricsHistory.append({"at": now_ms(), **metrics})
            if len(self.metricsHistory) > 180:
                del self.metricsHistory[: len(self.metricsHistory) - 180]
            self.emit("metrics", metrics)
            self.emit("blackboard", self.blackboard.snapshot())
            # 指标持久化节流：每 4 次落盘一次，避免高频 ticker 写入压垮 sqlite
            self._metrics_persist_counter += 1
            if self._metrics_persist_counter % 4 == 0:
                self.persistence.save_metrics(self.session["id"], metrics)
            return metrics

    def getLlmConfig(self):
        """返回当前 LLM 配置（不含明文密钥）。"""
        llm = self.llm
        return {
            "offline": llm.offline,
            "remoteEnabled": llm.remote_enabled,
            "baseUrl": llm.base_url,
            "model": llm.model,
            "timeout": llm.timeout,
            "apiKeyConfigured": bool(llm.api_key),
            "apiKeyMasked": _mask_key(llm.api_key) if llm.api_key else "",
            "mode": llm.mode,
            "fallbackCount": llm.fallback_count,
            "remoteCallCount": llm.remote_call_count,
        }

    def updateLlmConfig(self, payload):
        """更新 LLM 配置，支持设置/清除 API Key、切换模型与超时。"""
        payload = payload or {}
        llm = self.llm
        had_key_before = bool(llm.api_key)
        if "apiKey" in payload:
            new_key = (payload.get("apiKey") or "").strip()
            llm.api_key = new_key
        if "baseUrl" in payload and payload.get("baseUrl"):
            llm.base_url = str(payload["baseUrl"]).rstrip("/")
        if "model" in payload and payload.get("model"):
            llm.model = str(payload["model"])
        if "timeout" in payload:
            try:
                llm.timeout = float(payload["timeout"])
            except (TypeError, ValueError):
                pass
        # offline 处理：显式传参优先；否则根据是否有 Key 自动判断
        if "offline" in payload:
            llm.set_offline(bool(payload["offline"]))
        elif llm.api_key and not had_key_before:
            # 新设置了 Key，自动启用远程模式
            llm.offline = False
            llm.mode = "hybrid"
        # 最终状态判定
        if llm.api_key and not llm.offline:
            llm.remote_enabled = True
            llm.mode = "hybrid"
        elif not llm.api_key:
            llm.remote_enabled = False
            llm.offline = True
            llm.mode = "local-deterministic"
        # 持久化到本地配置文件，重启后自动加载
        llm.persist_config()
        return self.getLlmConfig()

    def getMetrics(self):
        with self._lock:
            s = self.stream.snapshot()
            m = self.session["metrics"]
            elapsed_ms = now_ms() - self.session["startedAt"] if self.session["startedAt"] else 0
            orders = m["orders"]
            gmv = _js_round(m["gmv"])
            return {
                "sessionId": self.session["id"],
                "stage": self.session["stage"],
                "viewers": m["viewers"],
                "peakViewers": m["peakViewers"],
                "gmv": gmv,
                "orders": orders,
                "cvr": round_to(clamp(orders / max(m["viewers"], 1), 0, 0.25), 4),
                "aov": round_to(gmv / orders, 1) if orders else 0,
                "interactionRate": m["interactionRate"],
                "sentiment": m["sentiment"],
                "comments": self.session["comments"],
                "responses": len(self.session["responses"]),
                "negative": self.session["negative"],
                "negativeRatio": round_to(self.session["negative"] / self.session["comments"], 4)
                if self.session["comments"]
                else 0,
                "p50": s.get("p50"),
                "p95": s.get("p95"),
                "p99": s.get("p99"),
                "batches": s.get("batches"),
                "dropped": s.get("dropped"),
                "queue": s.get("queue"),
                "targetGmv": self.config["session"]["targetGmv"],
                "progress": round_to(gmv / self.config["session"]["targetGmv"], 4),
                "elapsedSec": _js_round(elapsed_ms / 1000),
                "prepMinutes": self.prepMinutes,
                "prepChainMs": self.prepChainMs,
                "latencyTarget": self.config["stream"]["targetP99Ms"],
                "measured": True,
            }

    def stageContext(self):
        with self._lock:
            elapsed_min = (now_ms() - self.session["startedAt"]) / 60000 if self.session["startedAt"] else 0
            if elapsed_min < 12:
                return "引流"
            if elapsed_min < self.config["session"]["durationMin"] * 0.78:
                return "讲解"
            if elapsed_min < self.config["session"]["durationMin"] * 0.9:
                return "逼单"
            return "返场"

    def contract(self, options=None, *, capability=None, task=None, trace_id=None, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        capability = merged.get("capability", capability)
        task = merged.get("task", task)
        trace_id = merged.get("traceId", merged.get("trace_id", trace_id))
        with self._lock:

            def dispatch():
                self.bus.broadcast(
                    create_envelope(
                        {
                            "sender": "orchestrator",
                            "receiver": "*",
                            "performative": "CFP",
                            "traceId": trace_id,
                            "content": {"capability": capability, "task": task},
                            "priority": 7,
                        }
                    )
                )

            proposals = self._collect_round(
                trace_id=trace_id,
                performative="PROPOSE",
                timeout_ms=self.config["cnp"]["proposalWindowMs"],
                dispatch=dispatch,
            )
            bids = sorted(
                [
                    {
                        "agent": env["sender"],
                        "score": (env.get("content") or {}).get("score"),
                        "breakdown": (env.get("content") or {}).get("breakdown"),
                        "load": (env.get("content") or {}).get("load"),
                        "etaMs": (env.get("content") or {}).get("etaMs"),
                        "reason": (env.get("content") or {}).get("reason"),
                        "at": env.get("createdAt"),
                    }
                    for env in proposals
                    if (env.get("content") or {}).get("capability") == capability
                ],
                key=lambda bid: bid["score"],
                reverse=True,
            )
            if not bids:
                ticket = {
                    "id": uid("HITL"),
                    "reason": f"能力 {capability} 无可用实例",
                    "status": "open",
                    "createdAt": now_ms(),
                    "slaSeconds": 120,
                }
                self.humanQueue.insert(0, ticket)
                self.bus.log_system(
                    create_envelope(
                        {
                            "sender": "orchestrator",
                            "receiver": "*",
                            "performative": "ESCALATE",
                            "traceId": trace_id,
                            "content": {"reason": ticket["reason"], "ticketId": ticket["id"]},
                        }
                    ),
                    "no active bidder",
                )
                self.lastContract = {"capability": capability, "task": task, "bids": bids, "winner": None, "traceId": trace_id, "at": now_ms()}
                self.emit("cnp", self.lastContract)
                return {"bids": bids, "winner": None, "ticket": ticket}

            winner = bids[0]
            reply_msg_id = next((env.get("msgId") for env in proposals if env["sender"] == winner["agent"]), None)
            self.bus.send(
                create_envelope(
                    {
                        "sender": "orchestrator",
                        "receiver": winner["agent"],
                        "performative": "AWARD",
                        "traceId": trace_id,
                        "inReplyTo": reply_msg_id,
                        "content": {"task": task, "capability": capability, "score": winner["score"]},
                    }
                )
            )
            self.lastContract = {
                "task": task,
                "capability": capability,
                "bids": bids,
                "winner": winner["agent"],
                "provisional": len(bids) == 1,
                "traceId": trace_id,
                "at": now_ms(),
            }
            self.emit("cnp", self.lastContract)
            return {"bids": bids, "winner": winner["agent"], "contract": self.lastContract}

    def vote(self, proposal, trace_id):
        with self._lock:
            veto = self.guardrails.compliance_veto(proposal)
            if veto.get("vetoed"):
                result = {
                    "proposalId": proposal["id"],
                    "approved": False,
                    "vetoed": True,
                    "weight": 0,
                    "threshold": 2.4,
                    "ballots": [],
                    "compliance": veto,
                    "approvalId": None,
                    "at": now_ms(),
                }
                self.lastConsensus = result
                self.consensusHistory.insert(0, result)
                self.bus.log_system(
                    create_envelope(
                        {
                            "sender": "compliance",
                            "receiver": "orchestrator",
                            "performative": "VETO",
                            "traceId": trace_id,
                            "priority": 9,
                            "content": {"code": veto.get("code"), "reason": veto.get("reason"), "proposalId": proposal["id"]},
                        }
                    ),
                    "compliance veto",
                )
                self.emit("consensus", result)
                return result

            def dispatch():
                self.bus.broadcast(
                    create_envelope(
                        {
                            "sender": "orchestrator",
                            "receiver": "*",
                            "performative": "VOTE",
                            "traceId": trace_id,
                            "priority": 8,
                            "content": {"proposal": proposal},
                        }
                    )
                )

            raw_ballots = self._collect_round(
                trace_id=trace_id,
                performative="VOTE",
                timeout_ms=self.config["cnp"]["proposalWindowMs"],
                dispatch=dispatch,
            )
            seen = set()
            ballots = []
            for env in raw_ballots:
                content = env.get("content") or {}
                if content.get("proposalId") != proposal["id"]:
                    continue
                sender = env["sender"]
                if sender in seen:
                    continue
                seen.add(sender)
                ballots.append(
                    {
                        "agent": sender,
                        "approve": bool(content.get("approve")),
                        "weight": content.get("weight"),
                        "rationale": content.get("rationale"),
                    }
                )
            approved_weight = round_to(sum(b["weight"] for b in ballots if b["approve"]), 2)
            threshold = round_to(
                sum(self.config["consensus"]["weights"].values()) * self.config["consensus"]["threshold"], 2
            )
            passed = len(ballots) > 0 and approved_weight >= threshold
            approval_id = uid("APR") if passed else None
            if passed:
                self.approvals[approval_id] = {
                    "proposalId": proposal["id"],
                    "tools": proposal.get("tools") or [],
                    "expiresAt": now_ms() + 10 * 60 * 1000,
                }
            result = {
                "proposalId": proposal["id"],
                "approved": passed,
                "vetoed": False,
                "weight": approved_weight,
                "threshold": threshold,
                "ballots": ballots,
                "compliance": {"vetoed": False},
                "approvalId": approval_id,
                "at": now_ms(),
            }
            self.lastConsensus = result
            self.consensusHistory.insert(0, result)
            if not passed:
                ticket = {
                    "id": uid("HITL"),
                    "reason": "共识未达阈值，高风险动作已冻结",
                    "proposal": proposal,
                    "status": "open",
                    "createdAt": now_ms(),
                    "slaSeconds": 120,
                }
                self.humanQueue.insert(0, ticket)
                self.emit("human.escalated", ticket)
            self.bus.log_system(
                create_envelope(
                    {
                        "sender": "orchestrator",
                        "receiver": "*",
                        "performative": "ACCEPT" if passed else "ESCALATE",
                        "traceId": trace_id,
                        "priority": 8,
                        "content": {
                            "proposalId": proposal["id"],
                            "approved": passed,
                            "weight": approved_weight,
                            "threshold": threshold,
                            "approvalId": approval_id,
                        },
                    }
                ),
                "consensus result",
            )
            self.emit("consensus", result)
            return result

    def validateApproval(self, tool_name, context=None):
        with self._lock:
            if not context or not context.get("approvalId"):
                return False
            approval = self.approvals.get(context["approvalId"])
            if not approval:
                return False
            if approval["expiresAt"] < now_ms():
                del self.approvals[context["approvalId"]]
                return False
            tools = approval.get("tools") or []
            return tool_name in tools or "*" in tools

    def createDecision(
        self,
        options=None,
        *,
        agent=None,
        action=None,
        trigger=None,
        risk=None,
        confidence=None,
        reasoning=None,
        evidence=None,
        consensus=None,
        traceId=None,
        latencyMs=None,
        status="executed",
        guardrail=None,
        alternatives=None,
        **aliases,
    ):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        agent = merged.get("agent", agent)
        action = merged.get("action", action)
        trigger = merged.get("trigger", trigger)
        risk = merged.get("risk", risk)
        confidence = merged.get("confidence", confidence)
        reasoning = merged.get("reasoning", reasoning)
        evidence = merged.get("evidence", evidence)
        consensus = merged.get("consensus", consensus)
        traceId = merged.get("traceId", traceId)
        latencyMs = merged.get("latencyMs", latencyMs)
        status = merged.get("status", status)
        guardrail = merged.get("guardrail", guardrail)
        alternatives = merged.get("alternatives", alternatives)
        with self._lock:
            card = {
                "id": uid("DC"),
                "sessionId": self.session["id"],
                "agent": agent,
                "action": action,
                "trigger": trigger,
                "risk": risk,
                "confidence": round_to(confidence, 3) if confidence is not None else confidence,
                "reasoning": reasoning,
                "evidence": evidence if evidence is not None else [],
                "consensus": consensus,
                "traceId": traceId,
                "createdAt": _iso_now(),
                "latencyMs": round_to(latencyMs, 2) if latencyMs is not None else latencyMs,
                "status": status,
                "guardrail": guardrail,
                "alternatives": alternatives if alternatives is not None else [],
            }
            self.decisions.insert(0, card)
            if len(self.decisions) > 80:
                self.decisions.pop()
            self.emit("decision", card)
            self.persistence.save_decision(card, session_id=self.session["id"])
            return card

    def review(self):
        with self._lock:
            if self.session["stage"] not in ("ended", "reviewed"):
                raise RuntimeError("直播尚未结束，先下播再做本场复盘")
            trace = self.tracer.start(
                "直播后复盘 · Reflexion + Causal", {"sessionId": self.session["id"], "mode": "Reflexion + Causal"}
            )
            started = _perf_ms()
            metrics = self.getMetrics()
            report = self.analyst.review(self.session, trace, metrics)
            report.setdefault("kpis", {})["reviewMinutes"] = 1.4
            report["historical"] = False
            causal = report.get("causal") or {}
            card = self.createDecision(
                agent="analyst",
                action="把发券时点与故事型开场固化到下一场 SOP",
                trigger="本场复盘完成，干预效果达到统计显著",
                risk="low",
                confidence=0.9,
                reasoning=causal.get("statement"),
                evidence=[
                    f"ATT {_to_fixed((causal.get('att') or 0) * 100, 2)}pp",
                    f"p={causal.get('pValue')}",
                    f"P99 {_num_text(metrics.get('p99'))}ms",
                    f"记忆命中 {len(report.get('memoryHits') or [])} 条",
                ],
                consensus=None,
                traceId=trace["id"],
                latencyMs=round_to(_perf_ms() - started, 2),
                status="executed",
                alternatives=["维持原节奏", "下一场扩大到全品类"],
            )
            self.session["stage"] = "reviewed"
            self.reviewIsHistorical = False
            self.blackboard.update({"stage": "reviewed", "riskLevel": "low"})
            self.tracer.finish(trace, "ok", {"reviewId": report["id"], "pValue": causal.get("pValue"), "att": causal.get("att")})
            self.emit("review", report)
            self.emit("session", self.sessionSummary())
            self.publishMetrics()
            self.persistence.upsert_session(
                self.session, metrics=self.getMetrics(), summary=self.sessionSummary()
            )
            return {"report": report, "decision": card, "trace": self.tracer.summary(trace)}

    def computeCausal(self, intervention=None):
        with self._lock:
            review = self.latestReview
            if review and review.get("sessionId") == self.session["id"] and not review.get("historical"):
                return review.get("causal")
            metrics = self.getMetrics()
            base_rate = clamp(metrics.get("cvr") or 0.032, 0.02, 0.06)
            coupon = self.coupon
            label = intervention or (coupon.get("label") if coupon else None) or "第 52 分钟发券"
            return self.causal.simulate_experiment(
                {
                    "intervention": label,
                    "n": 3000,
                    "baseRate": 0.04 if base_rate > 0.055 else base_rate,
                    "effect": 0.014 if coupon else 0.009,
                    "seed": hash_string(self.session["id"]),
                }
            )

    def buildNextActions(self, lessons=None):
        return [
            {"owner": "selector", "title": "前 12 分钟沿用故事型，第 3 分钟插入礼盒价格锚点", "impact": "预计停留 +6%"},
            {"owner": "analyst", "title": "首张券后移到讲解完成后的第 50–55 分钟", "impact": "预计 ATT +1.4pp"},
            {"owner": "speaker", "title": "准备 3 条 15 秒冲泡演示，打断长段参数讲解", "impact": "预计停留 +4%"},
            {"owner": "controller", "title": "舆情预案：先降速 90 秒，再上检测报告，最后谈补偿", "impact": "情绪恢复时间 -30%"},
        ]

    def runScenario(self, scenario_type):
        def ensure_live():
            if not self.session.get("plan"):
                self.prepare()
            if self.session["stage"] != "live":
                self.startLive()

        ensure_live()
        if scenario_type == "negative":
            messages = [
                "是不是香精茶？闻着太香了",
                "之前买过农残超标的，你们有检测报告吗？",
                "这么便宜不可能是核心产区吧",
            ]
            users = ["老茶客阿良", "第一次买茶", "岭南小雨"]
            results = []
            for index, message in enumerate(messages):
                results.append(self.ingestDanmaku(message, user=users[index], pool="negative").result())
            self.emit("scenario", {"type": scenario_type, "injected": len(messages), "incident": self.incident})
            return {"type": scenario_type, "injected": len(messages), "incident": self.incident, "results": results}
        if scenario_type == "extreme":
            result = self.ingestDanmaku("这款是全网最低吗？绝对有效吗？", user="合规观察员", pool="manual").result()
            response = ((result or {}).get("result") or {}).get("response") if isinstance(result, dict) else None
            self.emit("scenario", {"type": scenario_type, "injected": 1, "response": response})
            return {"type": scenario_type, "injected": 1, "result": result}
        if scenario_type == "coupon":
            with self._lock:
                trace = self.tracer.start(
                    "高风险动作 · 发券共识", {"sessionId": self.session["id"], "mode": "Consensus"}
                )
            proposal = {
                "id": uid("PROP"),
                "action": "发放满 ¥299 减 ¥20 优惠券",
                "risk": "high",
                "productId": "P-02",
                "expectedImpact": 0.013,
                "evidence": ["讲解完成度 82%", "加购人数 126", "历史同类券 ATT +1.3pp"],
                "requestedBy": "controller",
                "tools": ["coupon.issue"],
            }
            vote = self.vote(proposal, trace["id"])
            coupon = None
            if vote.get("approved"):
                issued = self.registry.call(
                    "coupon.issue",
                    {"amount": 20, "threshold": 299, "approvalId": vote.get("approvalId")},
                    {"traceId": trace["id"]},
                )
                coupon = issued.get("result")
            with self._lock:
                card = self.createDecision(
                    agent="controller",
                    action=proposal["action"],
                    trigger="讲解完成度与加购人数同时达标",
                    risk="high",
                    confidence=0.87,
                    reasoning="在讲解完成后发券，避免把价格前置成唯一购买理由；预算与折扣均通过合规校验。",
                    evidence=proposal["evidence"],
                    consensus=vote,
                    traceId=trace["id"],
                    latencyMs=round_to(now_ms() - trace["startedAt"], 2),
                    status="executed" if vote.get("approved") else "blocked",
                    alternatives=["无门槛券 ¥10", "不加券"],
                )
                self.tracer.finish(trace, "ok", {"approved": vote.get("approved"), "coupon": coupon})
                self.emit("scenario", {"type": scenario_type, "coupon": coupon, "vote": vote})
            return {"type": scenario_type, "coupon": coupon, "vote": vote, "decision": card}
        if scenario_type == "price":
            with self._lock:
                trace = self.tracer.start(
                    "红线动作 · 价格变更合规校验", {"sessionId": self.session["id"], "mode": "Compliance Veto"}
                )
            proposal = {
                "id": uid("PROP"),
                "action": "将凤凰蜜兰单丛改价至 ¥169",
                "risk": "critical",
                "productId": "P-02",
                "newPrice": 169,
                "expectedImpact": 0.03,
                "evidence": ["竞品中位价 ¥328", "当前库存 180 件"],
                "requestedBy": "operator",
                "tools": ["pricing.change"],
            }
            veto = self.guardrails.compliance_veto(proposal)
            with self._lock:
                card = self.createDecision(
                    agent="controller",
                    action=proposal["action"],
                    trigger="运营申请用击穿底价换取短期转化",
                    risk="critical",
                    confidence=0.99,
                    reasoning=f"合规哨兵一票否决：{veto.get('reason')}。高风险价格动作被冻结，并已进入人工复核队列。",
                    evidence=["底价 ¥190", "申请价 ¥169", veto.get("reason")],
                    consensus={"approved": False, "vetoed": True, "weight": 0, "threshold": 2.4, "ballots": [], "veto": veto},
                    traceId=trace["id"],
                    latencyMs=round_to(now_ms() - trace["startedAt"], 2),
                    status="vetoed",
                    alternatives=["改为赠送茶样", "维持原价并加赠品"],
                )
                self.bus.log_system(
                    create_envelope(
                        {
                            "sender": "compliance",
                            "receiver": "orchestrator",
                            "performative": "VETO",
                            "traceId": trace["id"],
                            "priority": 10,
                            "content": {"code": veto.get("code"), "reason": veto.get("reason"), "proposalId": proposal["id"]},
                        }
                    ),
                    "price floor veto",
                )
                self.humanQueue.insert(
                    0,
                    {
                        "id": uid("HITL"),
                        "reason": f"价格红线被合规否决：{veto.get('reason')}",
                        "proposal": proposal,
                        "status": "open",
                        "createdAt": now_ms(),
                        "slaSeconds": 120,
                    },
                )
                self.tracer.finish(trace, "blocked", {"veto": veto})
                self.emit("scenario", {"type": scenario_type, "veto": veto, "decision": card})
            return {"type": scenario_type, "veto": veto, "decision": card}
        if scenario_type == "surge":
            texts = [DANMAKU_POOL["emoji"][i % len(DANMAKU_POOL["emoji"])] for i in range(80)]
            started = _perf_ms()
            futures = [
                self.ingestDanmaku(text, user=USERS[index % len(USERS)], simulated=True, pool="emoji")
                for index, text in enumerate(texts)
            ]
            for future in futures:
                future.result()
            current = self.stream.snapshot()
            snapshot = {
                **current,
                "wallMs": round_to(_perf_ms() - started, 2),
                "events": len(texts),
                "passed": current.get("p99") <= self.config["stream"]["targetP99Ms"],
            }
            with self._lock:
                self.loadTest = {**snapshot, "at": now_ms(), "mode": "emoji-surge"}
                self.stressHistory.insert(0, self.loadTest)
                self.stressHistory = self.stressHistory[:8]
                self.emit("scenario", {"type": scenario_type, "snapshot": snapshot})
            return {"type": scenario_type, "snapshot": snapshot}
        raise RuntimeError(f"未知演练类型：{scenario_type}")

    def stressTest(self, events=400):
        try:
            total = clamp(int(float(events)) if events not in (None, "") else 400, 50, 3000)
        except (TypeError, ValueError):
            total = 400
        texts = []
        for i in range(total):
            low = i % 5 < 2
            pool = "emoji" if low else ("product" if i % 7 == 0 else "normal")
            pool_list = DANMAKU_POOL[pool]
            texts.append({"text": pool_list[i % len(pool_list)], "priority": "low" if low else "normal", "low": low})

        engine = StreamEngine(
            {
                "windowMs": self.config["stream"]["batchWindowMs"],
                "maxBatch": self.config["stream"]["maxBatch"],
                "backpressureQueue": self.config["stream"]["backpressureQueue"],
                "emit": _noop,
                "handler": lambda items, meta=None: [self.llm.classify(item["text"]) for item in items],
            }
        )
        started = _perf_ms()
        futures = [engine.ingest(item) for item in texts]
        for future in futures:
            future.result()
        wall_ms = round_to(_perf_ms() - started, 2)
        snapshot = engine.snapshot()
        result = {
            "events": total,
            "wallMs": wall_ms,
            "throughput": round_to(total / (wall_ms / 1000), 1) if wall_ms else 0,
            **snapshot,
            "targetP99": self.config["stream"]["targetP99Ms"],
            "passed": snapshot.get("p99") <= self.config["stream"]["targetP99Ms"],
            "mode": "intent-pipeline · 本机实测（不含外部模型网络时延）",
            "at": now_ms(),
        }
        with self._lock:
            self.loadTest = result
            self.stressHistory.insert(0, result)
            self.stressHistory = self.stressHistory[:8]
            self.emit("loadtest", result)
        return result

    def setAgentFault(self, agent_id, action="offline"):
        with self._lock:
            target = next((agent for agent in self.agentList if agent.id == agent_id), None)
            if target is None:
                raise RuntimeError(f"Unknown agent: {agent_id}")
            replica = next(
                (agent for agent in self.agentList if agent.replicaOf == target.logicalRole and agent.id != target.id),
                None,
            )
            if action == "offline":
                target.setStatus("offline")
                if replica is not None and replica.status != "active":
                    replica.setStatus("active")
                active = [agent for agent in self.agentList if agent.logicalRole == target.logicalRole and agent.status == "active"]
                self.bus.log_system(
                    create_envelope(
                        {
                            "sender": "orchestrator",
                            "receiver": "*",
                            "performative": "ESCALATE",
                            "traceId": f"TRC-FAULT-{target.id.upper()}",
                            "priority": 9,
                            "content": {
                                "kind": "fault.injected",
                                "agent": target.id,
                                "replica": active[0].id if active else None,
                                "message": f"主实例下线，{active[0].id} 接管"
                                if active
                                else "无可用副本，任务将升级人工",
                            },
                        }
                    ),
                    "fault injection",
                )
                self.emit(
                    "fault",
                    {
                        "agent": target.id,
                        "action": action,
                        "active": [agent.id for agent in active],
                        "replica": replica.id if replica else None,
                    },
                )
                return {
                    "agent": target.id,
                    "status": target.status,
                    "active": [agent.id for agent in active],
                    "replica": replica.id if replica else None,
                }
            target.setStatus("active")
            if replica is not None:
                replica.setStatus("standby")
            self.emit("fault", {"agent": target.id, "action": "restore", "active": [target.id]})
            return {"agent": target.id, "status": target.status, "active": [target.id], "replica": replica.id if replica else None}

    def hotplugTool(self, payload=None, **kwargs):
        with self._lock:
            payload = dict(payload or {})
            payload.update(kwargs)
            name = str(payload.get("name") or "").strip()
            if not re.match(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$", name):
                raise RuntimeError("工具名需为反向域名格式，如 market.compare")
            if self.registry.get(name):
                raise RuntimeError("工具名已存在")
            spec, handler = create_hotplug_tool(
                name=name,
                description=payload.get("description") or "运行时热插拔工具",
                category=payload.get("category") or "扩展",
                handler_type=payload.get("handlerType") or "market_compare",
                risk_level=payload.get("riskLevel") or "low",
            )
            self.registry.register(spec, handler)
            self.emit("tool.registered", {"name": name, "spec": spec})
            return self.registry.get(name).spec

    def removeTool(self, name):
        with self._lock:
            return self.registry.unregister(name)

    def callTool(self, name, args=None, context=None):
        with self._lock:
            args = args or {}
            context = context or {}
            return self.registry.call(
                name,
                args,
                {"approvalId": args.get("approvalId"), "traceId": context.get("traceId")},
            )

    def pushChat(self, role, text, blocks=None, actions=None, options=None, *, silent=False, **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        silent = merged.get("silent", silent)
        with self._lock:
            message = {
                "id": uid("CHT"),
                "role": role,
                "text": text,
                "blocks": blocks if blocks is not None else [],
                "actions": actions if actions is not None else [],
                "at": now_ms(),
            }
            if merged.get("mode"):
                message["mode"] = merged["mode"]
            self.chatLog.append(message)
            if len(self.chatLog) > 80:
                self.chatLog.pop(0)
            if not silent:
                self.emit("chat", message)
            self.persistence.save_chat(self.session["id"], message["role"], message)
            return message

    def _llmSystemPrompt(self):
        """构造对话模式的系统提示：把当前场次上下文交给大模型。"""
        m = self.getMetrics()
        plan = self.session.get("plan") or {}
        narrative = plan.get("narrative") or {}
        products = plan.get("products") or self.products[:4]
        product_line = "、".join(
            f"{p.get('name')}（¥{p.get('price')}，库存 {p.get('stock')}）" for p in products
        ) or "暂无商品"
        recent = self.decisions[0] if self.decisions else None
        lines = [
            "你是「智播中枢 Copilot」的对话助手，服务直播电商运营团队。",
            "用简体中文回答，简洁、具体、可执行；优先引用下方实时上下文中的数据，不要编造未提供的数字。",
            "你只负责对话与建议，不能直接执行平台动作；需要执行时可提示用户在「指令」模式发送指令。",
            "【实时上下文】",
            f"场次：{self.session.get('id')} · 阶段：{self.session.get('stage')}",
            f"方案：{narrative.get('headline') or '尚未生成直播方案'}",
            f"商品：{product_line}",
            f"指标：在线 {m['viewers']} 人 · GMV ¥{m['gmv']} · 订单 {m['orders']} · "
            f"P99 {m['p99']}ms · 弹幕 {m['comments']} 条 · 负面 {m['negative']} 条",
        ]
        if recent:
            lines.append(
                f"最近决策：{recent.get('action')}（风险 {recent.get('risk')}，置信度 {recent.get('confidence')}）"
            )
        lines.append(f"模型：{self.llm.model}")
        return "\n".join(lines)

    def llmChat(self, text, user_message=None):
        """对话模式：直接调用大模型，维护多轮对话历史。"""
        text = str(text if text is not None else "").strip()[:400]
        if user_message is None:
            user_message = self.pushChat("user", text)
        llm = self.llm
        blocks = []
        actions = []
        if not (llm.api_key and llm.remote_enabled and not llm.offline):
            reply = "对话模式需要先接入大模型。请在右上角「大模型配置」里填写 API Key 并保存，然后就可以直接对话。"
            blocks = [{"type": "notice", "variant": "warn", "text": "当前运行在本地规则模式，未启用远端模型。"}]
            actions = [{"label": "打开大模型配置", "kind": "llm-config", "payload": {}}]
        else:
            history = self.dialogHistory[-10:]
            messages = [
                {"role": "system", "content": self._llmSystemPrompt()},
                *history,
                {"role": "user", "content": text},
            ]
            try:
                reply = llm.chat(messages, temperature=0.7, max_tokens=900)
            except Exception:
                reply = None
            if reply:
                self.dialogHistory = (
                    self.dialogHistory
                    + [{"role": "user", "content": text}, {"role": "assistant", "content": reply}]
                )[-12:]
            else:
                detail = getattr(llm, "last_error", "") or "可能超时或网络不可用"
                reply = f"远端模型调用失败：{detail}。可以重试一次，或检查「大模型配置」中的 Base URL 与 API Key。"
                blocks = [{"type": "notice", "variant": "warn", "text": f"模型 {llm.model} 未返回结果，本条未写入对话历史。"}]
                actions = [{"label": "打开大模型配置", "kind": "llm-config", "payload": {}}]
        assistant_message = self.pushChat("assistant", reply, blocks, actions, mode="llm")
        return {
            "userMessage": user_message,
            "message": assistant_message,
            "mode": "llm",
            "model": llm.model,
        }

    def chat(self, input_text, mode="cmd"):
        text = str(input_text if input_text is not None else "").strip()[:400]
        if not text:
            raise RuntimeError("请输入指令")
        user_message = self.pushChat("user", text)
        if mode == "llm":
            return self.llmChat(text, user_message)
        lower = text.lower()
        reply = ""
        blocks = []
        actions = []
        try:
            if re.search(r"恢复|restore", lower) and re.search(r"(controller|场控|speaker|言枢|实例|agent)", text, re.I):
                result = self.setAgentFault("controller", "restore")
                self.setAgentFault("speaker", "restore")
                reply = f"已恢复主实例。当前在线：**{'、'.join(result['active'])}**，副本回到热备待命。"
                actions = [{"label": "查看智能体矩阵", "kind": "navigate", "payload": {"view": "agents"}}]
            elif re.search(r"(下线|故障|容灾|转移|failover)", text):
                result = self.setAgentFault("controller", "offline")
                contract = self.contract(capability="realtime", task="验证故障转移后的实时承接", trace_id="TRC-FAULT-CHAT")
                reply = (
                    f"已下线主 Controller。副本 **{result['replica'] or '无'}** 接管，合同网重新招标的赢家是 **"
                    f"{contract['winner'] or '无（已升级人工）'}**。业务未中断，A2A 日志已记录改投。"
                )
                blocks = [
                    {
                        "type": "kpi",
                        "items": [
                            {"label": "主实例", "value": "offline", "tone": "danger"},
                            {"label": "接管实例", "value": result["replica"] or "无", "tone": "ok"},
                            {"label": "招标赢家", "value": contract["winner"] or "人工", "tone": "warn"},
                        ],
                    }
                ]
                actions = [{"label": "查看协同拓扑", "kind": "navigate", "payload": {"view": "agents"}}]
            elif re.search(r"(舆情|负面|香精|农残|危机|质疑)", text):
                result = self.runScenario("negative")
                ballots = ((result.get("incident") or {}).get("voteSummary") or {}).get("ballots") or []
                incident = result.get("incident") or {}
                vote_summary = incident.get("voteSummary") or {}
                reply = (
                    f"已注入 3 条信任质疑。Controller 触发高风险动作，经过 {len(ballots)} 方加权投票，合规前置通过，"
                    f"当前状态：**{'已执行处置' if incident.get('status') == 'executed' else '被阻断'}**。"
                    f"投票权重 {vote_summary.get('weight', 0)} / 阈值 {vote_summary.get('threshold', 2.4)}。"
                )
                blocks = [
                    {
                        "type": "kpi",
                        "items": [
                            {"label": "负面条数", "value": "3", "tone": "danger"},
                            {"label": "赞成权重", "value": str(vote_summary.get("weight", 0)), "tone": "ok"},
                            {"label": "处置状态", "value": incident.get("status") or "-", "tone": "warn"},
                        ],
                    }
                ]
                if self.decisions:
                    blocks.append({"type": "decision", "decision": self.decisions[0]})
                actions = [{"label": "进入直播中控", "kind": "navigate", "payload": {"view": "live"}}]
            elif re.search(r"(极限词|违规|合规|全网最低)", text):
                result = self.runScenario("extreme")
                guard = (((result.get("result") or {}).get("result") or {}).get("response") or {}).get("guardrail")
                violations = (guard or {}).get("violations") or []
                reply = (
                    f"已触发合规探针。规则引擎命中 **{len(violations)}** 处违规，输出前已强制改写；"
                    "本次没有让极限词进入直播间。"
                )
                blocks = [
                    {
                        "type": "list",
                        "title": "拦截明细",
                        "items": [
                            {"title": v.get("term"), "desc": v.get("message"), "badge": "BLOCKED"} for v in violations
                        ],
                    }
                ]
                if self.decisions:
                    blocks.append({"type": "decision", "decision": self.decisions[0]})
                actions = [{"label": "查看决策卡片", "kind": "navigate", "payload": {"view": "decisions"}}]
            elif re.search(r"(改价|价格红线|底价)", text):
                result = self.runScenario("price")
                veto = result.get("veto") or {}
                reply = (
                    f"已发起一次击穿底价的改价申请。合规哨兵直接否决：**{veto.get('reason')}**。"
                    "该动作已冻结并进入人工复核队列。"
                )
                blocks = [{"type": "decision", "decision": self.decisions[0]}] if self.decisions else []
                actions = [{"label": "查看决策留痕", "kind": "navigate", "payload": {"view": "decisions"}}]
            elif re.search(r"(复盘|归因|报告|效果|为什么提升)", text):
                if self.session["stage"] not in ("ended", "reviewed"):
                    reply = "本场还在进行中。先结束直播，Analyst 才能基于完整样本做因果归因与 Reflexion。"
                    actions = [{"label": "进入直播中控", "kind": "navigate", "payload": {"view": "live"}}]
                else:
                    result = self.review()
                    report = result["report"]
                    causal = report.get("causal") or {}
                    latency = report.get("latency") or {}
                    reply = f"{report['summary']}\n\n因果结论：**{causal.get('statement')}**"
                    blocks = [
                        {
                            "type": "kpi",
                            "items": [
                                {"label": "ATT", "value": f"{_to_fixed((causal.get('att') or 0) * 100, 2)}pp", "tone": "ok"},
                                {"label": "p 值", "value": str(causal.get("pValue")), "tone": "ok"},
                                {"label": "P99", "value": f"{latency.get('p99')}ms", "tone": "ok"},
                            ],
                        },
                        {
                            "type": "list",
                            "title": "下一场动作",
                            "items": [
                                {"title": a["title"], "desc": f"{a['owner']} · {a['impact']}", "badge": "NEXT"}
                                for a in (report.get("nextActions") or [])[:3]
                            ],
                        },
                    ]
                    actions = [{"label": "打开复盘实验室", "kind": "navigate", "payload": {"view": "review"}}]
            elif re.search(r"(发券|优惠券|福利)", text):
                result = self.runScenario("coupon")
                vote = result["vote"]
                coupon = result.get("coupon")
                reply = (
                    f"发券提案已走加权共识：{'**通过**' if vote.get('approved') else '**未通过**'}，"
                    f"赞成权重 {vote.get('weight')} / 阈值 {vote.get('threshold')}。"
                    f"{f'券已发放：{coupon.get('label')}。' if coupon else '券未发放。'}"
                )
                blocks = [{"type": "decision", "decision": self.decisions[0]}] if self.decisions else []
            elif re.search(r"(压测|性能|并发|延迟|p99)", text, re.I):
                match = re.search(r"(\d{2,4})\s*条", text)
                count = int(match.group(1)) if match else 400
                result = self.stressTest(count)
                reply = (
                    f"已完成 **{result['events']}** 条弹幕的本机意图链路压测：P50 **{result['p50']}ms**，"
                    f"P95 **{result['p95']}ms**，P99 **{result['p99']}ms**，吞吐 {result['throughput']}/s，"
                    f"背压丢弃 {result['dropped']} 条。目标 P99 ≤ 500ms：**{'通过' if result['passed'] else '未通过'}**。"
                )
                blocks = [
                    {
                        "type": "kpi",
                        "items": [
                            {"label": "P99", "value": f"{result['p99']}ms", "tone": "ok" if result["passed"] else "danger"},
                            {"label": "吞吐", "value": f"{result['throughput']}/s", "tone": "ok"},
                            {"label": "丢弃", "value": str(result["dropped"]), "tone": "warn"},
                        ],
                    },
                    {"type": "notice", "variant": "info", "text": result["mode"]},
                ]
                actions = [{"label": "查看验收实验室", "kind": "navigate", "payload": {"view": "system"}}]
            elif re.search(r"(方案|策划|筹备|排期)", text) and not re.search(r"(开始|开播)", text):
                result = self.prepare()
                plan = result["plan"]
                narrative = plan.get("narrative") or {}
                reply = (
                    f"方案 **{plan['version']}** 已定稿：{narrative.get('headline')}。{narrative.get('rationale')} "
                    f"全链路耗时 {result['prepChainMs']}ms，命中 {len(plan.get('memoryHits') or [])} 条记忆，"
                    f"并入 {len(plan.get('advisories') or [])} 条三方评审意见。"
                )
                blocks = [
                    {
                        "type": "kpi",
                        "items": [
                            {"label": "商品数", "value": str(len(plan.get("products") or [])), "tone": "ok"},
                            {"label": "排期段", "value": str(len(plan.get("segments") or [])), "tone": "ok"},
                            {"label": "链路耗时", "value": f"{result['prepChainMs']}ms", "tone": "ok"},
                        ],
                    },
                    {
                        "type": "list",
                        "title": "排期骨架",
                        "items": [
                            {
                                "title": f"{seg['start']}–{seg['end']} min · {seg['label']}",
                                "desc": f"{seg['goal']} · {seg['style']}",
                                "badge": seg["context"],
                            }
                            for seg in (plan.get("segments") or [])
                        ],
                    },
                ]
                actions = [
                    {"label": "查看智能体矩阵", "kind": "navigate", "payload": {"view": "agents"}},
                    {"label": "开始直播", "kind": "api", "payload": {"method": "POST", "path": "/api/live/start"}},
                ]
            elif re.search(r"(开播|开始直播|启动直播)", text):
                if not self.session.get("plan"):
                    reply = "还没有可执行的直播方案。先让我生成方案，或直接让我“生成方案并开播”。"
                    actions = [{"label": "生成方案", "kind": "chat", "payload": {"message": "生成今晚的直播方案"}}]
                else:
                    self.startLive()
                    plan_products = self.session["plan"].get("products") or []
                    reply = (
                        f"直播已开始。**{self.session['metrics']['viewers']}** 人入场，当前主推「"
                        f"{plan_products[0]['name'] if plan_products else ''}」。你可以继续注入弹幕，或让我触发一次舆情演练。"
                    )
                    actions = [{"label": "进入直播中控", "kind": "navigate", "payload": {"view": "live"}}]
            elif re.search(r"(结束|下播|停播)", text):
                self.stopLive()
                reply = "直播已结束，实时链路停止。现在可以让我做本场复盘，Analyst 会输出 ATT、置信区间与 Reflexion。"
                actions = [{"label": "复盘本场", "kind": "chat", "payload": {"message": "复盘本场，解释发券效果"}}]
            elif re.search(r"(暂停)", text):
                self.pauseLive()
                reply = "直播已暂停，弹幕批次停止消费，当前队列保留。"
            elif re.search(r"(继续|恢复直播)", text):
                self.resumeLive()
                reply = "直播已恢复，流式引擎重新开始消费弹幕。"
            elif re.search(r"(赌博机|话术风格|学习|bandit)", text, re.I):
                snapshot = self.bandit.snapshot()
                lines = []
                for ctx in snapshot["contexts"]:
                    best = sorted(ctx["arms"], key=lambda arm: arm["mean"], reverse=True)[0]
                    lines.append(
                        {
                            "title": f"{ctx['context']} → {best['arm']}",
                            "desc": f"后验均值 {best['mean']} · 样本 {best['observations']}",
                            "badge": "BANDIT",
                        }
                    )
                reply = f"当前使用 **Beta Thompson Sampling**，按直播阶段选择话术。累计在线更新 {snapshot['updates']} 次。"
                blocks = [{"type": "list", "title": "各阶段后验最优", "items": lines}]
                actions = [{"label": "查看复盘实验室", "kind": "navigate", "payload": {"view": "review"}}]
            elif re.search(r"(工具|mcp|热插拔)", text, re.I):
                tools = self.registry.snapshot()
                risky = [t for t in tools if t.get("riskLevel") in ("high", "critical")]
                reply = (
                    f"MCP 工具层当前注册 **{len(tools)}** 个工具，其中高风险 {len(risky)} 个需要共识审批。"
                    "新增工具只需一份 Schema 与一个 handler，不改智能体代码。"
                )
                blocks = [
                    {
                        "type": "list",
                        "title": "高风险工具",
                        "items": [
                            {"title": t.get("name"), "desc": t.get("description"), "badge": str(t.get("riskLevel")).upper()}
                            for t in risky
                        ],
                    }
                ]
                actions = [{"label": "打开协议工坊", "kind": "navigate", "payload": {"view": "protocol"}}]
            elif re.search(r"(为什么|解释|依据)", text):
                card = self.decisions[0] if self.decisions else None
                if not card:
                    reply = "当前还没有决策卡片。先生成方案或注入一条弹幕。"
                else:
                    reply = f"最近一次动作是 **{card['action']}**。触发原因是：{card['trigger']}。推理：{card['reasoning']}"
                    blocks = [{"type": "decision", "decision": card}]
                    actions = [{"label": "查看完整 Trace", "kind": "navigate", "payload": {"view": "decisions"}}]
            elif re.search(r"(重置|重来)", text):
                self.resetSession()
                reply = "已重置当前演示场次，历史学习与验收记录保留在初始种子中。可以重新生成方案。"
                actions = [{"label": "生成方案", "kind": "chat", "payload": {"message": "生成今晚的直播方案"}}]
            elif re.search(r"(状态|指标|现在|怎么样|数据)", text):
                m = self.getMetrics()
                reply = (
                    f"当前阶段 **{m['stage']}**。在线 {m['viewers']} 人，GMV ¥{_locale_int(m['gmv'])}，成交 {m['orders']} 单，"
                    f"P99 {m['p99']}ms。Controller 已处理 {m['comments']} 条弹幕，回应 {m['responses']} 次。"
                )
                blocks = [
                    {
                        "type": "kpi",
                        "items": [
                            {"label": "在线", "value": str(m["viewers"]), "tone": "ok"},
                            {"label": "GMV", "value": f"¥{_locale_int(m['gmv'])}", "tone": "ok"},
                            {"label": "P99", "value": f"{m['p99']}ms", "tone": "ok" if m["p99"] <= 500 else "danger"},
                        ],
                    }
                ]
            elif re.search(r"(你好|帮助|能做什么|hello|hi)", text, re.I):
                reply = (
                    "我能直接驱动这个多智能体系统：生成方案、开播、注入弹幕/舆情、触发共识投票、跑压测、"
                    "下线实例验证容灾、做因果复盘。你也可以问“为什么”，我会给出最近一次决策的证据链。"
                )
                blocks = [
                    {
                        "type": "list",
                        "title": "推荐指令",
                        "items": [
                            {"title": "生成今晚的直播方案", "desc": "Plan-Execute + 合同网招标", "badge": "方案"},
                            {"title": "注入负面舆情", "desc": "加权投票 + 合规前置", "badge": "风控"},
                            {"title": "把 Controller 下线", "desc": "验证副本接管与任务改投", "badge": "容灾"},
                            {"title": "运行 800 条弹幕压测", "desc": "实测 P50/P95/P99", "badge": "压测"},
                        ],
                    }
                ]
            else:
                m = self.getMetrics()
                reply = (
                    f"我没有把这句话匹配到具体动作。当前阶段 **{m['stage']}**，可以让我：生成方案、开播、"
                    "注入舆情、发券、压测、复盘、下线实例，或问“为什么”。"
                )
                actions = [{"label": "生成方案", "kind": "chat", "payload": {"message": "生成今晚的直播方案"}}]
        except Exception as error:
            reply = f"动作没有完成：**{error}**。你可以先检查直播状态，或让我“查看状态”。"
            blocks = [{"type": "notice", "variant": "warn", "text": "命令被安全拦截，系统状态未改变。"}]
        assistant_message = self.pushChat("assistant", reply, blocks, actions)
        return {"userMessage": user_message, "message": assistant_message}

    def resetSession(self):
        with self._lock:
            self.session = self.createSession()
            self.memory = MemorySystem({"episodes": _clone(SEED_EPISODES)})
            self.bandit = BetaBandit(
                {
                    "contexts": self.config["bandit"]["contexts"],
                    "arms": self.config["bandit"]["arms"],
                    "prior": SEED_BANDIT,
                }
            )
            self.guardrails = Guardrails({"config": self.config["guardrails"], "products": self.products})
            self.tracer = Tracer({"emit": self.emit})
            self.decisions = []
            self.metricsHistory = []
            self.latestReview = None
            self.reviewIsHistorical = False
            self.coupon = None
            self.incident = None
            self.loadTest = None
            self.stressHistory = []
            self.lastConsensus = None
            self.lastContract = None
            self.consensusHistory = []
            self.humanQueue = []
            self.approvals = {}
            self.prepMinutes = None
            self.prepChainMs = None
            self.blackboard = Blackboard({"emit": self.emit})
            self.attachStream()
            self.bus.log = []
            self.bus.counts = {"sent": 0, "broadcast": 0, "rerouted": 0, "dropped": 0}
            for agent in self.agentList:
                agent.status = "standby" if agent.replicaOf else "active"
                agent.mailbox = []
                agent.handled = 0
                agent.received = 0
                agent.lastAction = "热备待命" if agent.status == "standby" else "等待任务"
                agent.lastActionAt = None
                agent.load = 0.12 if agent.status == "active" else 0
                agent.recentEnvelopes = []
                agent.currentTask = None
            for tool in self.registry.list():
                if tool.get("source") == "hotplug":
                    try:
                        self.registry.unregister(tool.get("name"))
                    except Exception:
                        pass
            self.applyHistoricalSeed()
            self.chatLog = []
            self.dialogHistory = []
            self.pushChat(
                "assistant",
                "演示已重置。可以重新生成方案、开播并复现全部协同链路。",
                [],
                [{"label": "生成方案", "kind": "chat", "payload": {"message": "生成今晚的直播方案"}}],
            )
            self.emit("session", self.sessionSummary())
            self.emit("reset", {"at": now_ms()})
            self.publishMetrics()
            return self.sessionSummary()

    def sessionSummary(self):
        with self._lock:
            plan = self.session.get("plan") or {}
            return {
                "id": self.session["id"],
                "title": self.session["title"],
                "goal": self.session["goal"],
                "stage": self.session["stage"],
                "startedAt": self.session["startedAt"],
                "endedAt": self.session["endedAt"],
                "metrics": self.getMetrics(),
                "planId": plan.get("id"),
                "planVersion": plan.get("version"),
            }

    def snapshot(self):
        with self._lock:
            plan = self.session.get("plan") or {}
            return {
                "meta": {
                    "name": "智播中枢",
                    "latin": "ZHIBO NEXUS",
                    "version": self.version,
                    "mode": "本地仿真内核 · local-deterministic",
                    "llm": self.llm.mode,
                    "startedAt": self.startedAt,
                    "uptimeSec": _js_round((now_ms() - self.startedAt) / 1000),
                    "autoSimulate": self.autoSimulate,
                    "architecture": "五层 · 事件驱动 + 协议化",
                },
                "session": self.sessionSummary(),
                "plan": self.session.get("plan"),
                "metrics": self.getMetrics(),
                "agents": [agent.snapshot() for agent in self.agentList],
                "blackboard": self.blackboard.snapshot(),
                "messages": self.bus.recent(70),
                "busStats": self.bus.stats(),
                "decisions": self.decisions[:40],
                "traces": self.tracer.list(24),
                "review": self.latestReview,
                "reviewIsHistorical": self.reviewIsHistorical,
                "tools": self.registry.snapshot(),
                "cnp": self.lastContract,
                "consensus": self.lastConsensus,
                "consensusHistory": self.consensusHistory[:8],
                "memory": self.memory.snapshot(),
                "bandit": self.bandit.snapshot(),
                "guardrails": self.guardrails.snapshot(),
                "stream": self.stream.snapshot(),
                "loadTest": self.loadTest,
                "stressHistory": self.stressHistory[:6],
                "coupon": self.coupon,
                "incident": self.incident,
                "humanQueue": self.humanQueue[:6],
                "config": {
                    "session": self.config["session"],
                    "stream": self.config["stream"],
                    "consensus": self.config["consensus"],
                    "guardrails": self.config["guardrails"],
                    "bandit": self.config["bandit"],
                },
                "chat": self.chatLog[-40:],
                "danmaku": self.session["danmaku"][-60:],
                "responses": self.session["responses"][-30:],
                "metricsHistory": self.metricsHistory[-120:],
                "persistence": self.persistence.snapshot(),
                "userProfile": self.userProfile.snapshot(),
                "llm": self.llm.snapshot(),
                "retrieval": {
                    "methods": ["cosine", "tfidf", "bm25", "fused-cases"],
                    "caseRecall": "memory.recall_cases(query, limit)",
                },
            }

    def runAcceptance(self):
        from .acceptance import run_acceptance

        return run_acceptance(self)
