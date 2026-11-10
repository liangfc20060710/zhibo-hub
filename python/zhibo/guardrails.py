from __future__ import annotations

import math
import re
from decimal import Decimal

from .util import now_ms

SOFT_REPLACEMENTS = [
    ["全网最低价", "本场专属价"],
    ["全网最低", "本场专属价"],
    ["最便宜", "很有竞争力的价格"],
    ["100%有效", "体验因人而异"],
    ["绝对有效", "体验因人而异"],
    ["绝对", "相对"],
    ["根治", "日常品饮"],
    ["治疗", "日常品饮"],
    ["降血糖", "日常品饮"],
    ["降血压", "日常品饮"],
    ["无副作用", "个体感受不同"],
    ["永久", "长期"],
    ["国家级", "具备资质"],
    ["秒杀全网", "本场限时"],
]

_PRICE_RE = re.compile(r"(\d{2,5})\s*元")
_INVENTORY_RE = re.compile(r"库存\s*(\d+)")
_ACTION_PRICE_RE = re.compile(r"(\d{3,5})\s*元")
_DISCLAIMER_RE = re.compile(r"(体感|功效|养生|睡眠|血糖|血压)")
_NAN = float("nan")


def _text(value) -> str:
    return "" if value is None else str(value)


def _get(target, *names: str, default=None):
    if target is None:
        return default
    if isinstance(target, dict):
        for name in names:
            if name in target and target[name] is not None:
                return target[name]
        return default
    for name in names:
        if hasattr(target, name):
            value = getattr(target, name)
            if value is not None:
                return value
    return default


def _pick(options: dict, *names: str, default=None):
    for name in names:
        value = options.get(name)
        if value is not None:
            return value
    return default


def _to_fixed(value, digits: int = 0) -> str:
    if value is None or (isinstance(value, float) and (math.isnan(value) or math.isinf(value))):
        return "NaN" if value is None or math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    negative = value < 0
    scaled = Decimal(abs(value)).scaleb(digits)
    count = int(math.floor(scaled + Decimal("0.5")))
    quantum = 10**digits
    whole, frac = divmod(count, quantum)
    body = f"{whole}.{frac:0{digits}d}" if digits else str(whole)
    return f"-{body}" if negative else body


def _num_text(value) -> str:
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer():
            return str(int(value))
        return repr(value)
    return str(value)


def _div(numerator, denominator) -> float:
    if numerator is None or denominator is None:
        return _NAN
    if denominator == 0:
        if numerator == 0:
            return _NAN
        return math.inf if numerator > 0 else -math.inf
    return numerator / denominator


class Guardrails:
    def __init__(self, options=None, products=None, **kwargs) -> None:
        merged: dict = {}
        if isinstance(options, dict) and ("config" in options or "products" in options):
            merged.update(options)
        elif options is not None:
            merged["config"] = options
        if products is not None:
            merged["products"] = products
        merged.update(kwargs)

        self.config = _pick(merged, "config") or {}
        self.products = _pick(merged, "products") or []
        self.vetoes: list[dict] = []

    def inspect_script(self, text, product=None, **kwargs) -> dict:
        if isinstance(product, dict) and "product" in product:
            product = product["product"]
        elif product is None and kwargs:
            product = kwargs.get("product")

        source = _text(text)
        violations: list[dict] = []
        for word in _get(self.config, "bannedWords", "banned_words", default=[]) or []:
            if word in source:
                violations.append(
                    {
                        "type": "banned_word",
                        "term": word,
                        "message": f"命中违禁/极限词「{word}」",
                    }
                )

        prices = [int(match.group(1)) for match in _PRICE_RE.finditer(source)]
        if product:
            floor = _get(product, "floor")
            for price in prices:
                if floor is not None and price < floor:
                    violations.append(
                        {
                            "type": "price_floor",
                            "term": _num_text(price),
                            "message": f"口播价格 ¥{_num_text(price)} 低于 {_text(_get(product, 'name'))} 底价 ¥{_num_text(floor)}",
                        }
                    )
            stock = _get(product, "stock")
            inventory_match = _INVENTORY_RE.search(source)
            if inventory_match and stock is not None and int(inventory_match.group(1)) > stock * 1.25:
                violations.append(
                    {
                        "type": "inventory_claim",
                        "term": inventory_match.group(1),
                        "message": f"口播库存 {inventory_match.group(1)} 高于工具返回值 {_num_text(stock)}",
                    }
                )

        rewritten = source
        for term, replacement in SOFT_REPLACEMENTS:
            rewritten = rewritten.replace(term, replacement)

        disclaimer = _text(_get(self.config, "requireDisclaimer", "require_disclaimer"))
        requires_disclaimer = _DISCLAIMER_RE.search(source) is not None
        if requires_disclaimer and disclaimer not in rewritten:
            rewritten = f"{rewritten}（{disclaimer}）"

        high_risk = any(
            violation["type"] in ("price_floor", "banned_word") for violation in violations
        )
        return {
            "pass": len(violations) == 0,
            "violations": violations,
            "rewritten": rewritten,
            "requiresDisclaimer": requires_disclaimer,
            "risk": "high" if high_risk else "low",
        }

    def check_price(self, product, price) -> dict:
        if not product:
            return {"pass": False, "reason": "商品不存在"}

        floor = _get(product, "floor")
        if floor is not None and price < floor:
            return {
                "pass": False,
                "reason": f"出价 ¥{_num_text(price)} 低于底价 ¥{_num_text(floor)}，触发价格红线",
                "code": "PRICE_FLOOR",
            }

        discount = 1 - _div(price, _get(product, "price"))
        max_discount = _get(self.config, "maxDiscount", "max_discount")
        if max_discount is not None and discount > max_discount + 0.0001:
            return {
                "pass": False,
                "reason": f"折扣 {_to_fixed(discount * 100, 1)}% 超过单场上限 {_to_fixed(max_discount * 100, 0)}%",
                "code": "MAX_DISCOUNT",
            }
        return {"pass": True, "discount": discount}

    def compliance_veto(self, proposal) -> dict:
        action = _text(_get(proposal, "action"))
        evidence = _get(proposal, "evidence", default=[]) or []

        price_match = _ACTION_PRICE_RE.search(action)
        product_id = _get(proposal, "productId", "product_id")
        if product_id:
            product = next(
                (item for item in self.products if _get(item, "id") == product_id), None
            )
            new_price = _get(proposal, "newPrice", "new_price")
            target_price = new_price if new_price is not None else (
                int(price_match.group(1)) if price_match else None
            )
            if target_price is not None:
                price_check = self.check_price(product, target_price)
                if not price_check.get("pass"):
                    veto: dict = {}
                    if price_check.get("code") is not None:
                        veto["code"] = price_check["code"]
                    veto["reason"] = price_check.get("reason")
                    veto["severity"] = "critical"
                    veto["at"] = now_ms()
                    self.vetoes.insert(0, veto)
                    return {"vetoed": True, **veto}

        script = _get(proposal, "script")
        if script:
            inspection = self.inspect_script(script, product=_get(proposal, "product"))
            if not inspection["pass"]:
                veto = {
                    "code": "SCRIPT_VIOLATION",
                    "reason": "；".join(violation["message"] for violation in inspection["violations"]),
                    "severity": "high",
                    "at": now_ms(),
                }
                self.vetoes.insert(0, veto)
                return {"vetoed": True, **veto}

        if _get(proposal, "risk") == "high" and len(evidence) == 0:
            veto = {
                "code": "NO_EVIDENCE",
                "reason": "高风险动作缺少可核验证据，合规要求补充后再表决",
                "severity": "high",
                "at": now_ms(),
            }
            self.vetoes.insert(0, veto)
            return {"vetoed": True, **veto}

        return {"vetoed": False}

    def snapshot(self) -> dict:
        return {
            "bannedWords": _get(self.config, "bannedWords", "banned_words", default=[]),
            "priceFloorRatio": _get(self.config, "priceFloorRatio", "price_floor_ratio"),
            "maxDiscount": _get(self.config, "maxDiscount", "max_discount"),
            "vetoes": self.vetoes[:6],
        }
