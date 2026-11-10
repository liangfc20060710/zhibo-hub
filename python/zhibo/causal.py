from __future__ import annotations

import math
from decimal import Decimal

from .util import Rng, round_to, two_proportion_test

DEFAULT_METHOD = "随机分流 A/B · 两比例 z 检验"
SIMULATED_METHOD = "随机分流 A/B · 本机仿真样本"
DEFAULT_INTERVENTION = "第 52 分钟发放 ¥15 无门槛券"
DEFAULT_SEED = 20261108


def _pick(options: dict, *names: str, default=None):
    for name in names:
        value = options.get(name)
        if value is not None:
            return value
    return default


def _merge(options, kwargs) -> dict:
    merged: dict = {}
    if isinstance(options, dict):
        merged.update(options)
    merged.update(kwargs)
    return merged


def _field(target, name: str, default=None):
    if target is None:
        return default
    value = target.get(name) if isinstance(target, dict) else getattr(target, name, None)
    return default if value is None else value


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


class CausalEngine:
    def __init__(self, options=None, **kwargs) -> None:
        merged = _merge(options, kwargs)
        if options is not None and not isinstance(options, dict):
            merged["seed"] = options
        self.seed = _pick(merged, "seed", default=DEFAULT_SEED)
        self.rng = Rng(self.seed)

    def analyze(self, options=None, **kwargs) -> dict:
        merged = _merge(options, kwargs)
        intervention = merged.get("intervention")
        treated = merged.get("treated")
        control = merged.get("control")
        method = _pick(merged, "method", default=DEFAULT_METHOD)

        stat = two_proportion_test(
            _field(treated, "conversions", 0),
            _field(treated, "n", 0),
            _field(control, "conversions", 0),
            _field(control, "n", 0),
        )
        ci = stat["ci95"]
        significant = stat["pValue"] < 0.05 and (ci[0] > 0 or ci[1] < 0)
        sign = "+" if stat["diff"] >= 0 else ""
        return {
            "intervention": intervention,
            "method": method,
            "treated": treated,
            "control": control,
            "att": round_to(stat["diff"], 6),
            "relative": round_to(stat["relative"], 6),
            "pValue": round_to(stat["pValue"], 6),
            "ci95": [round_to(ci[0], 6), round_to(ci[1], 6)],
            "z": round_to(stat["z"], 3),
            "significant": significant,
            "verdict": ("显著为正" if stat["diff"] > 0 else "显著为负") if significant else "未达显著",
            "statement": (
                f"因为「{intervention}」，转化率变化 {sign}{_to_fixed(stat['diff'] * 100, 2)}pp"
                f"（95% CI {_to_fixed(ci[0] * 100, 2)}pp ~ {_to_fixed(ci[1] * 100, 2)}pp，"
                f"p={_to_fixed(stat['pValue'], 4)}）。"
            ),
            "simulation": True,
        }

    def simulate_experiment(self, options=None, **kwargs) -> dict:
        merged = _merge(options, kwargs)
        intervention = _pick(merged, "intervention", default=DEFAULT_INTERVENTION)
        n = _pick(merged, "n", default=2800)
        base_rate = _pick(merged, "baseRate", "base_rate", default=0.032)
        effect = _pick(merged, "effect", default=0.014)
        seed = _pick(merged, "seed", default=DEFAULT_SEED)

        rng = Rng(seed)

        def draw(probability: float, count: int) -> int:
            successes = 0
            for _ in range(count):
                if rng.next() < probability:
                    successes += 1
            return successes

        treated = {"n": n, "conversions": draw(base_rate + effect, n)}
        control = {"n": n, "conversions": draw(base_rate, n)}
        return self.analyze(
            {
                "intervention": intervention,
                "treated": treated,
                "control": control,
                "method": SIMULATED_METHOD,
            }
        )

    def dag(self, intervention=None) -> dict:
        label = intervention if intervention is not None else "发券"
        return {
            "intervention": label,
            "nodes": [
                {"id": "traffic", "label": "自然流量", "type": "context", "note": "时段 / 推荐位 / 粉丝回访"},
                {"id": "coupon", "label": label, "type": "treatment", "note": "do(coupon=1)"},
                {"id": "dwell", "label": "停留时长", "type": "mediator", "note": "讲解完成度 / 节奏"},
                {"id": "interaction", "label": "互动行为", "type": "mediator", "note": "提问 / 点击 / 加购"},
                {"id": "conversion", "label": "成交转化", "type": "outcome", "note": "下单 / 支付"},
            ],
            "edges": [
                {"from": "traffic", "to": "dwell", "label": "选择偏差"},
                {"from": "traffic", "to": "conversion", "label": "自然波动"},
                {"from": "coupon", "to": "dwell", "label": "权益感知"},
                {"from": "dwell", "to": "interaction", "label": "内容承接"},
                {"from": "interaction", "to": "conversion", "label": "意图形成"},
                {"from": "coupon", "to": "conversion", "label": "直接作用"},
            ],
            "note": "以随机分流切断「流量 → 干预」的混杂路径，ATT 在可比样本上估计。",
        }
