from __future__ import annotations

import math
import re
from datetime import datetime

from .mcp import ToolError
from .util import now_ms, round_to, uid

_SLOW_RE = re.compile(r"检测|农残|合规")
_URGE_RE = re.compile(r"库存|倒计时")
_REPORT_RE = re.compile(r"报告|检测")


def _schema(properties=None, required=None):
    return {
        "type": "object",
        "properties": properties if properties is not None else {},
        "required": list(required) if required else [],
    }


def _field(type_, description, extra=None):
    return {"type": type_, "description": description, **(extra or {})}


def _tool(name, description, category, risk_level, parameters, handler, extra=None):
    spec = {
        "name": name,
        "description": description,
        "category": category,
        "riskLevel": risk_level,
        "parameters": parameters,
        "version": "1.0.0",
        **(extra or {}),
    }
    return (spec, handler)


def _arg(args, key, default=None):
    if not isinstance(args, dict):
        return default
    value = args.get(key, default)
    return default if value is None else value


def _truthy(value) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value != ""
    return True


def _number_text(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _text(value) -> str:
    return "" if value is None else str(value)


def _find(products, product_id):
    for item in products:
        if item.get("id") == product_id:
            return item
    return None


def _hotplug_market_compare(args=None, ctx=None):
    product_id = _arg(args, "productId", "P-01")
    return {
        "productId": product_id,
        "samples": [
            {"channel": "同产区品牌店", "price": 398},
            {"channel": "内容电商中位价", "price": 328},
            {"channel": "本场价", "price": 299},
        ],
        "median": 328,
        "note": "竞品比价 · 演示数据",
        "source": "hotplug:market.compare",
    }


def _hotplug_audience_weather(args=None, ctx=None):
    hour = _arg(args, "hour", datetime.now().hour)
    night = hour >= 19 and hour <= 22
    daytime = hour >= 12 and hour <= 14
    return {
        "hour": hour,
        "index": 0.92 if night else (0.61 if daytime else 0.42),
        "label": "夜间高活跃" if night else "常规活跃",
        "note": "人群活跃度 · 演示数据",
        "source": "hotplug:audience.weather",
    }


def _hotplug_margin_calc(args=None, ctx=None):
    price = _arg(args, "price", 299)
    cost = _arg(args, "cost", 168)
    return {
        "price": price,
        "cost": cost,
        "grossMargin": round_to((price - cost) / price, 4),
        "breakEvenUnits": int(math.ceil(1200 / max(price - cost, 1))),
        "note": "毛利测算 · 演示数据",
        "source": "hotplug:margin.calc",
    }


HOTPLUG_HANDLERS = {
    "market_compare": _hotplug_market_compare,
    "audience_weather": _hotplug_audience_weather,
    "margin_calc": _hotplug_margin_calc,
}


def create_builtin_tools(runtime):
    products = runtime.products

    def catalog_rank(args=None, ctx=None):
        category = _arg(args, "category")
        budget = _arg(args, "budget")
        limit = _arg(args, "limit", 3)
        rows = []
        for item in products:
            if _truthy(category) and item.get("category") != category:
                continue
            if _truthy(budget) and item.get("price") > budget:
                continue
            demand = item["demand"]
            rows.append({
                **item,
                "margin": round_to((item["price"] - item["cost"]) / item["price"], 3),
                "composite": round_to(
                    item["score"] * 0.6 + demand["cvr"] * 1000 * 0.3 + demand["searchIndex"] * 0.1,
                    2,
                ),
            })
        ranked = sorted(rows, key=lambda row: row["composite"], reverse=True)
        if isinstance(limit, float):
            limit = math.trunc(limit)
        selected = ranked[:limit]
        return {"count": len(selected), "products": selected}

    def catalog_get(args=None, ctx=None):
        product_id = _arg(args, "productId")
        product = _find(products, product_id)
        if product is None:
            raise ToolError(f"Unknown product: {_number_text(product_id)}")
        return {
            **product,
            "margin": round_to((product["price"] - product["cost"]) / product["price"], 3),
        }

    def demand_forecast(args=None, ctx=None):
        product_id = _arg(args, "productId")
        product = _find(products, product_id)
        if product is None:
            raise ToolError(f"Unknown product: {_number_text(product_id)}")
        forecast_units = product["demand"]["forecastUnits"]
        return {
            "productId": product_id,
            "horizon": "90min",
            "forecastUnits": forecast_units,
            "expectedOrders": int(round_to(forecast_units * product["demand"]["cvr"] * 100, 0)),
            "cvr": product["demand"]["cvr"],
            "searchIndex": product["demand"]["searchIndex"],
            "returnRate": product["demand"]["returnRate"],
            "confidence": 0.78,
            "method": "梯度提升树 · 同品类历史样本",
            "simulation": True,
        }

    def schedule_optimize(args=None, ctx=None):
        duration_min = _arg(args, "durationMin", 90)
        target_aov = _arg(args, "targetAov", 260)
        ranked = sorted(products, key=lambda item: item["score"], reverse=True)
        hero = ranked[0]
        profit = ranked[1]
        entry = next((item for item in ranked if item["category"] == "礼盒"), ranked[4])
        cut_one = int(round_to(duration_min * 0.45, 0))
        cut_two = int(round_to(duration_min * 0.78, 0))
        segments = [
            {
                "start": 0,
                "end": 12,
                "label": "引流预热",
                "context": "引流",
                "products": [entry["id"], hero["id"]],
                "goal": "承接自然流量，建立价格锚点",
                "style": runtime.bandit.choose("引流")["arm"],
            },
            {
                "start": 12,
                "end": cut_one,
                "label": "主推讲解",
                "context": "讲解",
                "products": [hero["id"]],
                "goal": "用产地、冲泡与检测报告完成信任建立",
                "style": runtime.bandit.choose("讲解")["arm"],
            },
            {
                "start": cut_one,
                "end": cut_two,
                "label": "矩阵承接",
                "context": "讲解",
                "products": [profit["id"], entry["id"]],
                "goal": f"承接不同价格带，抬升客单至 ¥{_number_text(target_aov)}",
                "style": runtime.bandit.choose("讲解")["arm"],
            },
            {
                "start": cut_two,
                "end": duration_min,
                "label": "返场收口",
                "context": "返场",
                "products": [entry["id"], hero["id"]],
                "goal": "用真实库存与限时权益完成收口",
                "style": runtime.bandit.choose("返场")["arm"],
            },
        ]
        return {
            "segments": segments,
            "totalMinutes": duration_min,
            "heroId": hero["id"],
            "rationale": "礼盒负责新客低门槛，主推单品负责信任与利润，返场用真实库存收口。",
            "styleSource": "上下文赌博机 · 按阶段 Thompson 采样",
        }

    def offer_simulate(args=None, ctx=None):
        target_gmv = _arg(args, "targetGmv", 80000)
        aov = _arg(args, "aov", 260)
        orders = int(math.ceil(target_gmv / max(aov, 1)))
        coupons = [
            {"name": "新客无门槛 ¥10", "threshold": 0, "amount": 10, "quota": 120, "purpose": "降低首单门槛"},
            {"name": "满 ¥299 减 ¥20", "threshold": 299, "amount": 20, "quota": 80, "purpose": "抬升客单价"},
            {"name": "返场 ¥15 尝鲜券", "threshold": 158, "amount": 15, "quota": 60, "purpose": "收口转化"},
        ]
        budget = sum(coupon["amount"] * coupon["quota"] for coupon in coupons)
        return {
            "ordersTarget": orders,
            "coupons": coupons,
            "budget": budget,
            "budgetRatio": round_to(budget / max(target_gmv, 1), 4),
            "expectedLift": 0.014,
            "guardrails": [
                "单张券需共识审批",
                "价格不得低于单品底价",
                "库存数字必须来自 inventory.check",
            ],
            "simulation": True,
        }

    def script_compose(args=None, ctx=None):
        intent = _arg(args, "intent")
        style = _arg(args, "style")
        stage = _arg(args, "stage", "讲解")
        reason = _arg(args, "reason")
        product = _find(products, _arg(args, "productId"))
        if product is None:
            product = products[0]
        selection = (
            {"arm": style, "context": stage}
            if _truthy(style)
            else runtime.bandit.choose(stage)
        )
        generated = runtime.llm.compose({
            "intent": intent,
            "product": product,
            "style": selection["arm"],
            "stage": stage,
            "reason": reason,
        })
        guard = runtime.guardrails.inspect_script(generated["text"], {"product": product})
        return {
            **generated,
            "productId": product["id"],
            "styleContext": stage,
            "styleSource": "指定" if _truthy(style) else "Thompson Sampling",
            "guardrail": guard,
            "finalText": generated["text"] if guard["pass"] else guard["rewritten"],
        }

    def script_compliance(args=None, ctx=None):
        product = _find(products, _arg(args, "productId"))
        return runtime.guardrails.inspect_script(_arg(args, "text"), {"product": product})

    def danmaku_classify(args=None, ctx=None):
        return runtime.llm.classify(_arg(args, "text"))

    def sentiment_analyze(args=None, ctx=None):
        result = runtime.llm.classify(_arg(args, "text"))
        return {
            "sentiment": result["sentiment"],
            "risk": result["risk"],
            "intent": result["intent"],
            "reasons": result["reasons"],
            "requiresEscalation": result["risk"] == "high" and result["sentiment"] < -0.6,
        }

    def inventory_check(args=None, ctx=None):
        product_id = _arg(args, "productId")
        product = _find(products, product_id)
        if product is None:
            raise ToolError(f"Unknown product: {_number_text(product_id)}")
        stock = product["stock"]
        return {
            "productId": product_id,
            "stock": stock,
            "safetyStock": int(round_to(stock * 0.18, 0)),
            "status": "tight" if stock < 100 else "healthy",
            "source": "WMS 实时快照（演示）",
            "checkedAt": now_ms(),
        }

    def price_guard(args=None, ctx=None):
        product_id = _arg(args, "productId")
        price = _arg(args, "price")
        product = _find(products, product_id)
        return {"productId": product_id, "targetPrice": price, **runtime.guardrails.check_price(product, price)}

    def memory_recall(args=None, ctx=None):
        query = _arg(args, "query")
        limit = _arg(args, "limit", 3)
        method = _arg(args, "method") or "fused"
        if method == "bm25":
            hits = runtime.memory.recall_bm25(query, limit)
            strategy = "BM25 (Okapi k1=1.5 b=0.75) · 案例相似度检索"
        elif method == "tfidf":
            hits = runtime.memory.recall_tfidf(query, limit)
            strategy = "TF-IDF · 词频-逆文档频率检索"
        else:
            hits = runtime.memory.recall_cases(query, limit)
            strategy = "融合检索：BM25 0.45 + TF-IDF 0.25 + 余弦 0.20 + 时效衰减 0.10"
        return {
            "query": query,
            "method": method,
            "hits": hits,
            "count": len(hits),
            "strategy": strategy,
            "graph": runtime.memory.semantic_query(query),
        }

    def metrics_snapshot(args=None, ctx=None):
        return runtime.getMetrics()

    def causal_attribution(args=None, ctx=None):
        return runtime.computeCausal(_arg(args, "intervention"))

    def human_escalate(args=None, ctx=None):
        ticket = {
            "id": uid("HITL"),
            "reason": _arg(args, "reason"),
            "proposal": _arg(args, "proposal"),
            "status": "open",
            "createdAt": now_ms(),
            "slaSeconds": 120,
        }
        runtime.humanQueue.insert(0, ticket)
        runtime.emit("human.escalated", ticket)
        return ticket

    def digital_human_direct(args=None, ctx=None):
        script = _text(_arg(args, "script"))
        emotion = _arg(args, "emotion", "warm")
        if _SLOW_RE.search(script):
            pace = "slow"
        elif _URGE_RE.search(script):
            pace = "fast"
        else:
            pace = "normal"
        if _REPORT_RE.search(script):
            gesture = "show_report"
        elif _URGE_RE.search(script):
            gesture = "point_timer"
        else:
            gesture = "open_hands"
        return {
            "avatar": "shanyin-01",
            "emotion": emotion,
            "gesture": gesture,
            "speechRate": pace,
            "subtitleCps": 6.2 if pace == "fast" else (3.8 if pace == "slow" else 4.8),
            "subtitle": script[:56],
            "renderMode": "streaming · 演示",
        }

    def coupon_issue(args=None, ctx=None):
        amount = _arg(args, "amount")
        threshold = _arg(args, "threshold")
        approval_id = _arg(args, "approvalId")
        label = (
            f"满 ¥{_number_text(threshold)} 减 ¥{_number_text(amount)}"
            if threshold is not None and threshold > 0
            else f"¥{_number_text(amount)} 无门槛券"
        )
        coupon = {
            "id": uid("CPN"),
            "amount": amount,
            "threshold": threshold,
            "approvalId": approval_id,
            "issuedAt": now_ms(),
            "status": "active",
            "label": label,
            "source": "共识审批后发放",
        }
        runtime.coupon = coupon
        runtime.blackboard.update({"couponActive": True})
        runtime.emit("coupon.issued", coupon)
        return coupon

    def pricing_change(args=None, ctx=None):
        product_id = _arg(args, "productId")
        price = _arg(args, "price")
        approval_id = _arg(args, "approvalId")
        product = _find(products, product_id)
        check = runtime.guardrails.check_price(product, price)
        if not check.get("pass"):
            raise ToolError(check.get("reason"))
        runtime.emit("price.changed", {"productId": product_id, "price": price, "approvalId": approval_id})
        return {
            "productId": product_id,
            "from": product["price"],
            "to": price,
            "approvalId": approval_id,
            "discount": round_to(1 - price / product["price"], 4),
            "appliedAt": now_ms(),
        }

    return [
        _tool(
            "catalog.rank",
            "按品类、预算与历史表现对商品排序，返回可解释的候选清单",
            "商品",
            "low",
            _schema(
                {
                    "category": _field("string", "品类过滤，如 绿茶 / 乌龙 / 礼盒"),
                    "budget": _field("number", "单品价格上限"),
                    "limit": _field("number", "返回条数", {"default": 3}),
                }
            ),
            catalog_rank,
        ),
        _tool(
            "catalog.get",
            "读取单个商品的参数、底价、库存与检测信息",
            "商品",
            "low",
            _schema({"productId": _field("string", "商品 ID")}, ["productId"]),
            catalog_get,
        ),
        _tool(
            "demand.forecast",
            "基于搜索指数、历史转化与库存估算单品需求区间",
            "数据",
            "low",
            _schema({"productId": _field("string", "商品 ID")}, ["productId"]),
            demand_forecast,
        ),
        _tool(
            "schedule.optimize",
            "生成直播节奏排期，按阶段选择话术策略与主推商品",
            "运营",
            "low",
            _schema(
                {
                    "durationMin": _field("number", "直播时长（分钟）"),
                    "targetAov": _field("number", "目标客单价"),
                },
                ["durationMin"],
            ),
            schedule_optimize,
        ),
        _tool(
            "offer.simulate",
            "模拟福利梯度与预算，输出券门槛、数量与预期增益",
            "运营",
            "medium",
            _schema(
                {
                    "targetGmv": _field("number", "目标 GMV"),
                    "aov": _field("number", "目标客单价"),
                },
                ["targetGmv"],
            ),
            offer_simulate,
        ),
        _tool(
            "script.compose",
            "按意图、商品与赌博机选择的话术风格生成口播稿，并附带数字人指令",
            "内容",
            "low",
            _schema(
                {
                    "intent": _field("string", "弹幕意图"),
                    "productId": _field("string", "商品 ID"),
                    "style": _field("string", "话术风格，留空则由赌博机选择"),
                    "stage": _field("string", "直播阶段", {"default": "讲解"}),
                    "reason": _field("string", "触发原因"),
                },
                ["intent"],
            ),
            script_compose,
        ),
        _tool(
            "script.compliance",
            "规则引擎强制校验违禁词、极限词、价格与库存口播",
            "合规",
            "low",
            _schema(
                {
                    "text": _field("string", "待校验文案"),
                    "productId": _field("string", "关联商品"),
                },
                ["text"],
            ),
            script_compliance,
        ),
        _tool(
            "danmaku.classify",
            "识别弹幕意图、情绪、优先级与对应商品",
            "数据",
            "low",
            _schema({"text": _field("string", "弹幕文本")}, ["text"]),
            danmaku_classify,
        ),
        _tool(
            "sentiment.analyze",
            "输出情绪分、风险等级与负面原因，用于实时场控",
            "数据",
            "low",
            _schema({"text": _field("string", "弹幕文本")}, ["text"]),
            sentiment_analyze,
        ),
        _tool(
            "inventory.check",
            "读取实时库存与安全库存，供场控与话术引用",
            "数据",
            "low",
            _schema({"productId": _field("string", "商品 ID")}, ["productId"]),
            inventory_check,
        ),
        _tool(
            "price.guard",
            "校验目标价格是否低于底价或超过单场折扣上限",
            "合规",
            "medium",
            _schema(
                {
                    "productId": _field("string", "商品 ID"),
                    "price": _field("number", "目标价格"),
                },
                ["productId", "price"],
            ),
            price_guard,
        ),
        _tool(
            "memory.recall",
            "先检索情景记忆与知识图谱，再交给生成模型，降低幻觉",
            "记忆",
            "low",
            _schema(
                {
                    "query": _field("string", "检索问题"),
                    "limit": _field("number", "返回条数", {"default": 3}),
                },
                ["query"],
            ),
            memory_recall,
        ),
        _tool(
            "metrics.snapshot",
            "读取当前场次的实时经营指标",
            "数据",
            "low",
            _schema(),
            metrics_snapshot,
        ),
        _tool(
            "causal.attribution",
            "对当前场次的干预做 ATT 估计、置信区间与显著性检验",
            "分析",
            "low",
            _schema({"intervention": _field("string", "干预名称")}),
            causal_attribution,
        ),
        _tool(
            "human.escalate",
            "将无法消解的冲突升级给人工，生成工单并冻结高风险动作",
            "运营",
            "medium",
            _schema(
                {
                    "reason": _field("string", "升级原因"),
                    "proposal": _field("object", "待人工复核的提案"),
                },
                ["reason"],
            ),
            human_escalate,
        ),
        _tool(
            "digital_human.direct",
            "把口播稿转成数字人情绪、手势、语速与字幕指令",
            "内容",
            "low",
            _schema(
                {
                    "script": _field("string", "口播稿"),
                    "emotion": _field("string", "情绪"),
                },
                ["script"],
            ),
            digital_human_direct,
        ),
        _tool(
            "coupon.issue",
            "发放优惠券。高风险动作，必须携带有效共识审批 ID",
            "运营",
            "high",
            _schema(
                {
                    "amount": _field("number", "券面额"),
                    "threshold": _field("number", "使用门槛"),
                    "approvalId": _field("string", "共识审批 ID"),
                },
                ["amount", "threshold"],
            ),
            coupon_issue,
            {"requiresApproval": True},
        ),
        _tool(
            "pricing.change",
            "调整商品价格。红线动作，必须通过共识审批且高于底价",
            "运营",
            "critical",
            _schema(
                {
                    "productId": _field("string", "商品 ID"),
                    "price": _field("number", "目标价格"),
                    "approvalId": _field("string", "共识审批 ID"),
                },
                ["productId", "price"],
            ),
            pricing_change,
            {"requiresApproval": True},
        ),
    ]


def create_hotplug_tool(name, description, category="扩展", handler_type=None, risk_level="low"):
    handler = HOTPLUG_HANDLERS.get(handler_type)
    if handler is None:
        raise ToolError(f"Unknown hotplug handler: {_number_text(handler_type)}")
    return _tool(
        name,
        description,
        category,
        risk_level,
        _schema(
            {
                "productId": _field("string", "商品 ID"),
                "hour": _field("number", "小时"),
                "price": _field("number", "价格"),
                "cost": _field("number", "成本"),
            }
        ),
        handler,
        {"source": "hotplug", "handlerType": handler_type},
    )


__all__ = ["create_builtin_tools", "create_hotplug_tool", "HOTPLUG_HANDLERS"]
