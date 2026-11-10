from __future__ import annotations

import math
import platform
import re
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

from .envelope import PERFORMATIVES, create_envelope
from .util import now_ms, round_to

__all__ = ["run_acceptance"]

VALID_RISKS = {"low", "medium", "high", "critical"}

_SANITIZE = re.compile(r"[-:TZ.]")


def _status_weight(status):
    if status == "pass":
        return 1
    if status == "warn":
        return 0.5
    return 0


def _perf_ms():
    return time.perf_counter() * 1000


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


def _iso_now():
    moment = datetime.now(timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"


def _text(value):
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _num_text(value)
    return str(value)


def _get(target, *keys, default=None):
    current = target
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key)
        elif current is None:
            return default
        else:
            current = getattr(current, key, None)
        if current is None:
            return default
    return current


def run_acceptance(runtime, stress_events=800):
    started = _perf_ms()
    runtime_events = []
    probes = []
    state = {}

    previous_emit = getattr(runtime, "_raw_emit", None)
    ticker_active = bool(getattr(runtime, "_tickerActive", False))
    auto_danmaku = getattr(runtime, "autoDanmaku", True)
    if callable(previous_emit):

        def counting_emit(event, payload=None):
            runtime_events.append({"type": event, "at": now_ms(), "payload": payload})
            return previous_emit(event, payload)

        runtime._raw_emit = counting_emit

    try:
        runtime.stopTicker()
        runtime.autoDanmaku = False
        def probe(id, group, title, target, run):
            t0 = _perf_ms()
            try:
                result = run() or {}
                probes.append({
                    "id": id,
                    "group": group,
                    "title": title,
                    "target": target,
                    "status": result.get("status", "pass") or "pass",
                    "metric": result.get("metric", "通过") if result.get("metric") is not None else "通过",
                    "detail": result.get("detail") or "",
                    "evidence": result.get("evidence")
                    if result.get("evidence") is not None else [],
                    "durationMs": round_to(_perf_ms() - t0, 2),
                })
            except Exception as error:
                probes.append({
                    "id": id,
                    "group": group,
                    "title": title,
                    "target": target,
                    "status": "fail",
                    "metric": "执行失败",
                    "detail": str(error),
                    "evidence": [],
                    "durationMs": round_to(_perf_ms() - t0, 2),
                })

        probe(
            "arch.topology",
            "架构与协议",
            "四个对等 Actor + 热备副本全部注册",
            "4 逻辑角色 + 2 热备",
            lambda: _probe_arch(runtime),
        )

        probe(
            "mcp.schema",
            "架构与协议",
            "MCP 工具全部自描述且风险分级",
            "≥18 个工具，100% JSON Schema",
            lambda: _probe_mcp_schema(runtime),
        )

        probe(
            "mcp.hotplug",
            "架构与协议",
            "工具热插拔：注册、调用、卸载",
            "不重启智能体完成增删",
            lambda: _probe_hotplug(runtime),
        )

        probe(
            "a2a.envelope",
            "架构与协议",
            "A2A 信封校验与 trace_id 贯穿",
            "11 类 performative，缺失 trace 即拒绝",
            _probe_envelope,
        )

        probe(
            "prep.plan",
            "认知与决策",
            "直播前 Plan-Execute 生成可执行方案",
            "方案含选品、排期、话术、福利",
            lambda: _probe_prep(runtime, state),
        )

        probe(
            "cnp.award",
            "协同与安全",
            "合同网招标产生分工",
            "≥3 个投标且按综合评分择优",
            lambda: _probe_cnp(runtime, state),
        )

        runtime.startLive()

        probe(
            "react.response",
            "认知与决策",
            "直播中 ReAct 实时响应",
            "意图识别 + 工具调用 + 话术",
            lambda: _probe_react(runtime, state),
        )

        probe(
            "guardrail.live",
            "协同与安全",
            "极限词触发拦截并合规改写",
            "违规草稿不直接输出",
            lambda: _probe_guardrail(runtime),
        )

        probe(
            "consensus.pass",
            "协同与安全",
            "高风险舆情动作通过加权共识",
            "权重 ≥ 2.4 且全员可追溯投票",
            lambda: _probe_consensus(runtime, state),
        )

        probe(
            "compliance.veto",
            "协同与安全",
            "合规智能体一票否决价格红线",
            "低于底价立即冻结",
            lambda: _probe_veto(runtime),
        )

        probe(
            "approval.gate",
            "协同与安全",
            "高风险工具必须携带有效审批",
            "无审批 → 拒绝；有审批 → 执行",
            lambda: _probe_approval(runtime, state),
        )

        probe(
            "fault.transfer",
            "稳定性与运维",
            "主实例故障自动切换热备",
            "同角色副本接管，消息不中断",
            lambda: _probe_fault(runtime),
        )

        runtime.stopLive()

        probe(
            "reflexion.review",
            "认知与决策",
            "直播后 Reflexion 写出可执行结论",
            "复盘含因果、教训、下一场动作",
            lambda: _probe_reflexion(runtime, state),
        )

        probe(
            "memory.recall",
            "认知与决策",
            "三层记忆检索与知识图谱",
            "工作 / 情景 / 语义均可查询",
            lambda: _probe_memory(runtime),
        )

        probe(
            "bandit.learning",
            "认知与决策",
            "上下文赌博机在线更新",
            "Beta 后验随场次累积",
            lambda: _probe_bandit(runtime),
        )

        probe(
            "causal.att",
            "认知与决策",
            "A/B 因果估计达到统计显著",
            "ATT > 0，p < 0.05，CI 不含 0",
            lambda: _probe_causal(runtime, state),
        )

        probe(
            "stream.p99",
            "稳定性与运维",
            "流式链路 P99 满足延迟预算",
            "P99 ≤ 500ms",
            lambda: _probe_stream(runtime, state, stress_events),
        )

        probe(
            "trace.coverage",
            "可观测性",
            "决策卡片全部可回溯到 trace",
            "100% 决策带 trace_id 与证据",
            lambda: _probe_trace(runtime),
        )

        probe(
            "availability.72h",
            "稳定性与运维",
            "72 小时可用性 ≥ 99.5%",
            "≥99.5% / 72h",
            _probe_availability,
        )

        probe(
            "business.uplift",
            "业务效果",
            "互动率 +40% / 转化率 +25%",
            "同品牌同品类灰度对照",
            lambda: _probe_business(state),
        )

        runtime.stopTicker()
        runtime.autoDanmaku = False

        passed = len([item for item in probes if item["status"] == "pass"])
        warned = len([item for item in probes if item["status"] == "warn"])
        failed = len([item for item in probes if item["status"] == "fail"])
        score = round_to(
            (sum(_status_weight(item["status"]) for item in probes) / len(probes)) * 100, 1
        )

        group_names = []
        for item in probes:
            if item["group"] not in group_names:
                group_names.append(item["group"])
        groups = [
            {
                "name": group,
                "total": len(items),
                "pass": len([item for item in items if item["status"] == "pass"]),
                "warn": len([item for item in items if item["status"] == "warn"]),
                "fail": len([item for item in items if item["status"] == "fail"]),
            }
            for group, items in (
                (name, [item for item in probes if item["group"] == name]) for name in group_names
            )
        ]

        decisions = [item for item in runtime.decisions if not item.get("historical")]
        prep = state.get("prep") or {}
        review_causal = _get(state, "review", "report", "causal", default={}) or {}
        causal_state = state.get("causal") or {}
        stress = state.get("stress") or {}

        def first_present(*values):
            for value in values:
                if value is not None:
                    return value
            return None

        return {
            "id": f"ACC-{_SANITIZE.sub('', _iso_now())[:14]}",
            "generatedAt": _iso_now(),
            "durationMs": round_to(_perf_ms() - started, 2),
            "score": score,
            "verdict": (
                ("通过 · 含待现场验证项" if warned else "通过") if failed == 0 else "存在阻塞项"
            ),
            "summary": {
                "total": len(probes),
                "pass": passed,
                "warn": warned,
                "fail": failed,
                "passRate": round_to((passed / len(probes)) * 100, 1),
            },
            "groups": groups,
            "probes": probes,
            "measured": {
                "prepChainMs": prep.get("prepChainMs"),
                "reviewPValue": first_present(review_causal.get("pValue"), causal_state.get("pValue")),
                "reviewAtt": first_present(review_causal.get("att"), causal_state.get("att")),
                "p50": stress.get("p50"),
                "p95": stress.get("p95"),
                "p99": stress.get("p99"),
                "throughput": stress.get("throughput"),
                "messages": runtime.bus.stats().get("sent"),
                "decisions": len(decisions),
                "traceEvents": len([item for item in runtime_events if item["type"] == "trace"]),
            },
            "environment": {
                "mode": "本地确定性内核 · 零外部依赖",
                "python": sys.version.split()[0],
                "platform": f"{sys.platform}/{platform.machine()}",
                "llm": runtime.llm.mode,
                "dataLabel": "业务指标为仿真数据，延迟为本机意图链路实测",
            },
        }
    finally:
        if callable(previous_emit):
            runtime._raw_emit = previous_emit
        if ticker_active:
            runtime.autoDanmaku = auto_danmaku
            runtime.startTicker()


def _probe_arch(runtime):
    primary = [agent for agent in runtime.agentList if not agent.replicaOf]
    replicas = [agent for agent in runtime.agentList if agent.replicaOf]
    roles = ("selector", "controller", "speaker", "analyst")
    covered = all(
        any(agent.logicalRole == role for agent in primary) for role in roles
    )
    return {
        "status": "pass" if covered and len(replicas) >= 2 else "fail",
        "metric": f"{len(primary)} 主实例 / {len(replicas)} 热备",
        "detail": "消息总线、版本化黑板、MCP 注册表与 Trace 收集器在同一运行时装配。",
        "evidence": [f"{agent.id} · {agent.cognition}" for agent in primary],
    }


def _probe_mcp_schema(runtime):
    tools = runtime.registry.list()
    described = [
        tool
        for tool in tools
        if tool.get("description")
        and (tool.get("parameters") or {}).get("type") == "object"
        and (tool.get("parameters") or {}).get("properties") is not None
        and tool.get("riskLevel") in VALID_RISKS
    ]
    coverage = round_to((len(described) / max(len(tools), 1)) * 100, 1)
    return {
        "status": "pass" if len(tools) >= 18 and len(described) == len(tools) else "fail",
        "metric": f"{len(tools)} 个工具 · {_num_text(coverage)}% 覆盖",
        "detail": "工具由运行时发现并调用；high / critical 动作额外要求共识审批。",
        "evidence": [f"{tool.get('name')} · {tool.get('riskLevel')}" for tool in tools[:5]],
    }


def _probe_hotplug(runtime):
    before = len(runtime.registry.list())
    runtime.hotplugTool({
        "name": "market.compare",
        "description": "竞品价格对比 · 验收热插拔探针",
        "handlerType": "market_compare",
    })
    call = runtime.callTool("market.compare", {"productId": "P-01"})
    runtime.removeTool("market.compare")
    after = len(runtime.registry.list())
    ok = (
        before == after
        and len(_get(call, "result", "samples", default=[]) or []) == 3
        and not runtime.registry.get("market.compare")
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{before} → {before + 1} → {after}",
        "detail": "新工具以 schema + handler 注册，智能体代码零改动；卸载后注册表恢复原状。",
        "evidence": ["market.compare 返回 3 条竞品样本", f"工具源标记 {call.get('tool')}"],
    }


def _probe_envelope():
    env = create_envelope({
        "sender": "acceptance",
        "receiver": "selector",
        "performative": "CFP",
        "traceId": "TRC-ACCEPTANCE",
        "content": {"capability": "planning"},
    })
    rejected = False
    try:
        create_envelope({"sender": "acceptance", "performative": "CFP"})
    except Exception:
        rejected = True
    return {
        "status": "pass"
        if env["traceId"] == "TRC-ACCEPTANCE" and rejected and len(PERFORMATIVES) >= 11
        else "fail",
        "metric": f"{len(PERFORMATIVES)} 类消息 · 非法信封已拒绝",
        "detail": "发送方、接收方、对话行为、优先级与 trace_id 统一封装。",
        "evidence": [f"信封 {env['msgId']}", f"performative={env['performative']}"],
    }


def _probe_prep(runtime, state):
    state["prep"] = runtime.prepare()
    plan = state["prep"]["plan"]
    offers = plan.get("offers") or {}
    complete = (
        len(plan.get("products") or []) >= 4
        and len(plan.get("scripts") or []) >= 3
        and bool(offers)
        and len(offers) >= 2
        and bool(plan.get("forecast"))
        and plan.get("version") == "v1.1"
    )
    return {
        "status": "pass" if complete else "fail",
        "metric": f"{plan.get('version')} · 链上 {_num_text(state['prep'].get('prepChainMs'))}ms",
        "detail": "Selector 承接策划，Speaker 与 Controller 提交评审建议后自主协商定稿。",
        "evidence": [
            f"{len(plan.get('products') or [])} 个商品 · {len(plan.get('scripts') or [])} 段话术",
            f"建议 {len(plan.get('advisories') or [])} 条已并入定稿",
        ],
    }


def _probe_cnp(runtime, state):
    contract = (state.get("prep") or {}).get("contract")
    if contract is None:
        contract = runtime.lastContract
    bids = contract.get("bids") or []
    ok = (
        len(bids) >= 3
        and bool(contract.get("winner"))
        and bids[0].get("score") >= bids[1].get("score")
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{len(contract['bids'])} 份投标 · 中标 {contract['winner']}",
        "detail": "能力匹配、当前负载、历史可靠性加权评分，无中央控制器指派。",
        "evidence": [f"{bid.get('agent')} · {_num_text(bid.get('score'))}" for bid in bids[:3]],
    }


def _probe_react(runtime, state):
    state["liveReply"] = runtime.ingestDanmaku(
        "这款明前龙井是核心产区吗？帮我看看参数", user="验收观众", pool="product"
    ).result()
    response = (state["liveReply"].get("result") or {}).get("response") or {}
    ok = response.get("intent") == "product_question" and bool(response.get("script")) and bool(
        response.get("traceId")
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{_num_text(response.get('latencyMs'))}ms · {response.get('actionLabel')}",
        "detail": "Controller 分类与节奏判断，Speaker 生成口播与数字人指令，链路带 trace。",
        "evidence": [
            f"意图 {response.get('intent')}",
            f"风险 {response.get('risk')}",
            f"话术 {_text(response.get('script'))[:34]}…",
        ],
    }


def _probe_guardrail(runtime):
    result = runtime.ingestDanmaku(
        "这款是全网最低吗？绝对有效吗？", user="合规观察员", pool="manual"
    ).result()
    response = (result.get("result") or {}).get("response") or {}
    guardrail = response.get("guardrail") or {}
    output = _text(response.get("script") or "")
    violations = guardrail.get("violations") or []
    intercepted = (
        response.get("status") == "guarded"
        and guardrail.get("pass") is False
        and len(violations) > 0
        and "全网最低价" not in output
        and "绝对有效" not in output
    )
    return {
        "status": "pass" if intercepted else "fail",
        "metric": f"{len(violations)} 处违规 · 已重写",
        "detail": "规则引擎在话术输出前强制校验，命中极限词立即替换为合规表述。",
        "evidence": [
            violations[0].get("message") if violations else "无违规",
            f"输出 {output[:42]}…",
        ],
    }


def _probe_consensus(runtime, state):
    state["incident"] = runtime.runScenario("negative")
    incident = state["incident"]["incident"]
    votes = incident.get("voteSummary") or {}
    ballots = votes.get("ballots") or []
    ok = (
        incident.get("status") == "executed"
        and (votes.get("weight") or 0) >= (votes.get("threshold") or 0)
        and len(ballots) == 4
        and all(ballot.get("approve") for ballot in ballots)
        and bool(incident.get("coupon"))
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{_to_fixed(votes.get('weight'), 1)} / {_to_fixed(votes.get('threshold'), 1)} 权重通过",
        "detail": "Controller 提案，四智能体独立投票；通过后经审批 ID 才能调用高风险管理工具。",
        "evidence": [
            f"{ballot.get('agent')} {'赞成' if ballot.get('approve') else '反对'} · {_num_text(ballot.get('weight'))}"
            for ballot in ballots
        ],
    }


def _probe_veto(runtime):
    result = runtime.runScenario("price")
    veto = result.get("veto") or {}
    consensus = _get(result, "decision", "consensus") or {}
    ok = (
        veto.get("vetoed") is True
        and veto.get("code") == "PRICE_FLOOR"
        and _get(result, "decision", "status") == "vetoed"
        and consensus.get("weight") == 0
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{veto.get('code') if veto.get('code') is not None else 'NO_VETO'} · 权重清零",
        "detail": "否决后不再进入投票，决策卡片以 vetoed 状态冻结，并进入人工复核队列。",
        "evidence": [
            veto.get("reason") if veto.get("reason") is not None else "未触发",
            _get(result, "decision", "action") if _get(result, "decision", "action") is not None else "—",
        ],
    }


def _probe_approval(runtime, state):
    state["coupon"] = runtime.runScenario("coupon")
    blocked = None
    try:
        runtime.callTool("coupon.issue", {"amount": 15, "threshold": 199})
    except Exception as error:
        blocked = getattr(error, "code", None)
    approval_id = (runtime.lastConsensus or {}).get("approvalId")
    issued = runtime.callTool(
        "coupon.issue", {"amount": 15, "threshold": 199, "approvalId": approval_id}
    )
    return {
        "status": "pass"
        if blocked == "APPROVAL_REQUIRED" and bool(_get(issued, "result", "id"))
        else "fail",
        "metric": "门禁生效" if blocked == "APPROVAL_REQUIRED" else "门禁失效",
        "detail": "工具层独立校验审批 ID 与工具白名单，智能体无法绕过共识直接发券。",
        "evidence": [
            f"无审批调用 → {blocked}",
            f"审批调用 → {_get(issued, 'result', 'id')}",
        ],
    }


def _probe_fault(runtime):
    fault = runtime.setAgentFault("controller", "offline")
    record = runtime.bus.send(
        create_envelope({
            "sender": "acceptance",
            "receiver": "controller",
            "performative": "INFORM",
            "traceId": "TRC-ACCEPTANCE-FAULT",
            "content": {"kind": "health.check"},
        })
    )
    runtime.setAgentFault("controller", "restore")
    ok = fault.get("status") == "offline" and "controller-b" in (record.get("deliveredTo") or [])
    return {
        "status": "pass" if ok else "fail",
        "metric": f"controller → {', '.join(record.get('deliveredTo') or []) or '无接管'}",
        "detail": "总线按逻辑角色解析目标，主实例离线后自动路由到 active 热备；恢复后原实例回主。",
        "evidence": [f"副本 {fault.get('replica')} 接管", f"投递 {record.get('msgId')}"],
    }


def _probe_reflexion(runtime, state):
    state["review"] = runtime.review()
    report = state["review"]["report"]
    ok = (
        len(report.get("lessons") or []) >= 3
        and len(report.get("nextActions") or []) == 4
        and isinstance(report.get("reflexion"), str)
        and len(report.get("memoryHits") or []) >= 0
        and bool(_get(report, "causal", "statement"))
    )
    duration_ms = report.get("durationMs")
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{len(report.get('lessons') or [])} 条教训 · {duration_ms if duration_ms is not None else '—'}ms",
        "detail": "Analyst 汇总指标、召回历史案例、生成反思，并把本场写入情景记忆。",
        "evidence": list((report.get("lessons") or [])[:2]),
    }


def _probe_memory(runtime):
    hits = runtime.memory.recall("舆情处置 检测报告 发券", 3)
    graph = runtime.memory.semantic_query("龙井")
    snapshot = runtime.memory.snapshot()
    ok = len(hits) > 0 and len(graph.get("nodes") or []) > 0 and snapshot.get("episodicCount", 0) >= 5
    labels = [node.get("label") for node in (graph.get("nodes") or [])[:2]]
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{snapshot.get('episodicCount')} 条情景 · {_get(snapshot, 'graph', 'nodes')} 节点",
        "detail": "情景记忆使用字符 n-gram 余弦与时间衰减排序，语义记忆沿商品—规则—话术图谱遍历。",
        "evidence": [
            f"召回 {len(hits)} 条，最高分 {hits[0].get('score') if hits else 0}",
            f"图谱命中 {'、'.join(_text(label) for label in labels)}",
        ],
    }


def _probe_bandit(runtime):
    snapshot = runtime.bandit.snapshot()
    observations = sum(
        arm.get("observations", 0) for context in snapshot.get("contexts") or [] for arm in context.get("arms") or []
    )
    return {
        "status": "pass" if snapshot.get("updates", 0) > 0 and observations > 0 else "fail",
        "metric": f"{snapshot.get('updates')} 次更新 · {observations} 个观测",
        "detail": "按直播阶段选择话术风格，用下单反馈更新 Beta(α, β)，随机采样保持探索。",
        "evidence": [f"{item.get('context')} → {item.get('chosen')}" for item in (snapshot.get("contexts") or [])[:2]],
    }


def _probe_causal(runtime, state):
    state["causal"] = runtime.causal.simulate_experiment({
        "intervention": "讲解完成后第 52 分钟发券",
        "n": 6000,
        "baseRate": 0.032,
        "effect": 0.014,
        "seed": 20261108,
    })
    causal = state["causal"]
    ci = causal.get("ci95") or [0, 0]
    ok = (
        bool(causal.get("significant"))
        and causal.get("att", 0) > 0.01
        and causal.get("pValue", 1) < 0.05
        and ci[0] > 0
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"ATT +{_to_fixed(causal.get('att', 0) * 100, 2)}pp · p={_to_fixed(causal.get('pValue', 0), 4)}",
        "detail": causal.get("statement"),
        "evidence": [
            f"95% CI {_to_fixed(ci[0] * 100, 2)}pp ~ {_to_fixed(ci[1] * 100, 2)}pp",
            causal.get("method"),
        ],
    }


def _probe_stream(runtime, state, stress_events):
    state["stress"] = runtime.stressTest(stress_events)
    stress = state["stress"]
    return {
        "status": "pass" if stress.get("passed") else "fail",
        "metric": f"P99 {_num_text(stress.get('p99'))}ms · {_num_text(stress.get('throughput'))}/s",
        "detail": (
            f"{stress.get('mode')}；动态批处理 {_num_text(stress.get('windowMs'))}ms / "
            f"最大 {_num_text(stress.get('maxBatch'))} 条，低价值弹幕在拥塞时降级。"
        ),
        "evidence": [
            f"P50 {_num_text(stress.get('p50'))}ms",
            f"P95 {_num_text(stress.get('p95'))}ms",
            f"丢弃 {_num_text(stress.get('dropped'))} 条",
        ],
    }


def _probe_trace(runtime):
    decisions = [item for item in runtime.decisions if not item.get("historical")]
    traced = [item for item in decisions if item.get("traceId") and runtime.tracer.get(item["traceId"])]
    spans = sum(
        len(runtime.tracer.get(item["traceId"]).get("spans") or [])
        for item in traced
        if runtime.tracer.get(item["traceId"])
    )
    complete = [
        item
        for item in decisions
        if item.get("action")
        and item.get("trigger")
        and item.get("reasoning")
        and isinstance(item.get("evidence"), list)
        and item.get("traceId")
    ]
    ok = (
        len(decisions) >= 6
        and len(traced) == len(decisions)
        and len(complete) == len(decisions)
        and spans >= 15
    )
    return {
        "status": "pass" if ok else "fail",
        "metric": f"{len(traced)}/{len(decisions)} 可追溯 · {spans} spans",
        "detail": "trace_id 贯穿弹幕、意图、工具、协商与输出，决策卡片可点开查看数据来源与推理。",
        "evidence": [f"{item.get('id')} → {item.get('traceId')}" for item in decisions[:3]],
    }


def _probe_availability():
    return {
        "status": "warn",
        "metric": "未执行 72h 连续压测",
        "detail": (
            "本次已完成故障转移、连续链路与压测；72 小时稳定性需在部署环境执行。"
            "验收如实标记为待现场验证，不伪造通过。"
        ),
        "evidence": ["建议：k8s 多副本 + 持续 Locust 流量 + Grafana 报警"],
    }


def _probe_business(state):
    att = _get(state, "causal", "att")
    uplift = (att * 100) if att else 0
    return {
        "status": "warn",
        "metric": "仿真 ATT 已显著，真实提升待验证",
        "detail": (
            "GMV、互动率、转化率均来自确定性种子与仿真样本，未接入真实店铺数据；"
            "需以历史直播为基准做灰度 A/B。"
        ),
        "evidence": [f"仿真 ATT +{_to_fixed(uplift, 2)}pp", "演示数据已在界面持续标注"],
    }
