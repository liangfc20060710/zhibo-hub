from __future__ import annotations

import math
import time
from datetime import datetime

from .util import clamp, round_to

# 时段分群
_TIME_SEGMENTS = [
    {"id": "early_morning", "label": "早间场", "start": 6, "end": 10, "archetype": "晨练养生型"},
    {"id": "noon", "label": "午间场", "start": 10, "end": 14, "archetype": "午休休闲型"},
    {"id": "afternoon", "label": "下午场", "start": 14, "end": 18, "archetype": "送礼决策型"},
    {"id": "evening", "label": "黄金场", "start": 18, "end": 22, "archetype": "高客单故事型"},
    {"id": "night", "label": "夜间场", "start": 22, "end": 24, "archetype": "深夜陪伴型"},
    {"id": "late_night", "label": "凌晨场", "start": 0, "end": 6, "archetype": "失眠陪伴型"},
]

# 价格敏感度分档
_PRICE_TIERS = [
    {"id": "low", "label": "价格高度敏感", "threshold": 0.6, "strategy": "强调尝鲜装与单价拆解"},
    {"id": "medium", "label": "价格中度敏感", "threshold": 0.85, "strategy": "强调性价比与同产区对比"},
    {"id": "high", "label": "价格不敏感", "threshold": 1.0, "strategy": "强调品质、稀缺与故事"},
]


def _now_ms() -> int:
    return int(time.time() * 1000)


class UserProfile:
    """用户画像与千人千面路由。

    基于用户的历史互动、下单、弹幕特征，识别新客/老客，
    计算价格敏感度，匹配时段人群，并为话术生成提供个性化参数。
    """

    def __init__(self, options=None) -> None:
        merged = options if isinstance(options, dict) else {}
        self.profiles = {}
        self.default_price_sensitivity = 0.5

    def _ensure(self, user_id):
        if user_id not in self.profiles:
            self.profiles[user_id] = {
                "userId": user_id,
                "firstSeen": _now_ms(),
                "lastSeen": _now_ms(),
                "interactionCount": 0,
                "orderCount": 0,
                "totalSpent": 0.0,
                "mentionedPrice": 0,
                "priceObjections": 0,
                "purchaseIntents": 0,
                "tags": [],
                "preferredStyles": {},
            }
        return self.profiles[user_id]

    def identify(self, user_id, *, order_history=None, seen_before=None):
        profile = self._ensure(user_id)
        profile["lastSeen"] = _now_ms()
        if isinstance(order_history, list):
            profile["orderCount"] = len(order_history)
            profile["totalSpent"] = float(sum(o.get("amount", 0) for o in order_history))
        # 新客 / 老客识别
        if seen_before is not None:
            is_returning = bool(seen_before)
        else:
            is_returning = profile["orderCount"] > 0 or profile["interactionCount"] >= 5
        profile["isNew"] = not is_returning
        profile["isReturning"] = is_returning
        return profile

    def record_interaction(self, user_id, *, intent=None, sentiment=None, text=None):
        profile = self._ensure(user_id)
        profile["interactionCount"] += 1
        profile["lastSeen"] = _now_ms()
        raw = (text or "").lower()
        price_signals = ["贵", "便宜", "价格", "优惠", "券", "折扣", "值吗", "性价比"]
        if any(signal in raw for signal in price_signals):
            profile["mentionedPrice"] += 1
        if intent == "price_objection":
            profile["priceObjections"] += 1
        if intent == "purchase_intent":
            profile["purchaseIntents"] += 1
        return profile

    def record_order(self, user_id, amount):
        profile = self._ensure(user_id)
        profile["orderCount"] += 1
        profile["totalSpent"] += float(amount or 0)
        profile["lastSeen"] = _now_ms()
        return profile

    def price_sensitivity(self, user_id) -> dict:
        profile = self._ensure(user_id)
        interactions = max(profile["interactionCount"], 1)
        price_signal_ratio = profile["priceObjections"] / interactions
        mention_ratio = profile["mentionedPrice"] / interactions
        # 价格敏感度 = 价格异议占比 * 0.6 + 价格提及占比 * 0.4
        sensitivity = round_to(clamp(price_signal_ratio * 0.6 + mention_ratio * 0.4, 0, 1), 4)
        if sensitivity <= 0.3:
            tier = _PRICE_TIERS[2]
        elif sensitivity <= 0.6:
            tier = _PRICE_TIERS[1]
        else:
            tier = _PRICE_TIERS[0]
        return {
            "score": sensitivity,
            "tier": tier["id"],
            "label": tier["label"],
            "strategy": tier["strategy"],
        }

    def time_segment(self, at=None) -> dict:
        moment = datetime.fromtimestamp((at or _now_ms()) / 1000)
        hour = moment.hour
        for segment in _TIME_SEGMENTS:
            if segment["start"] <= hour < segment["end"]:
                return {**segment, "hour": hour}
        return {"id": "night", "label": "夜间场", "start": 22, "end": 24, "archetype": "深夜陪伴型", "hour": hour}

    def preferred_style(self, user_id, stage=None) -> str:
        profile = self._ensure(user_id)
        styles = profile.get("preferredStyles") or {}
        if stage and stage in styles:
            return styles[stage]
        if styles:
            return max(styles.items(), key=lambda kv: kv[1])[0]
        # 冷启动：新客偏"故事型"，老客偏"对比型"，价格敏感偏"性价比型"
        if profile["isNew"]:
            return "故事型"
        ps = self.price_sensitivity(user_id)
        if ps["tier"] == "low":
            return "性价比型"
        return "对比型"

    def record_style_feedback(self, user_id, style, reward):
        profile = self._ensure(user_id)
        styles = profile.setdefault("preferredStyles", {})
        styles[style] = round_to(styles.get(style, 0) + (1 if reward else -0.5), 3)

    def route(self, user_id, *, stage=None, at=None) -> dict:
        """千人千面路由：返回该用户在当前时段与阶段的话术策略参数。"""
        profile = self.identify(user_id)
        ps = self.price_sensitivity(user_id)
        segment = self.time_segment(at)
        style = self.preferred_style(user_id, stage)
        return {
            "userId": user_id,
            "segment": profile["isNew"] and "new" or "returning",
            "isNew": profile["isNew"],
            "isReturning": profile["isReturning"],
            "orderCount": profile["orderCount"],
            "timeSegment": segment["id"],
            "timeLabel": segment["label"],
            "archetype": segment["archetype"],
            "priceSensitivity": ps["score"],
            "priceTier": ps["tier"],
            "priceStrategy": ps["strategy"],
            "preferredStyle": style,
            "stage": stage,
        }

    def snapshot(self, user_id=None):
        if user_id is None:
            return {
                "totalUsers": len(self.profiles),
                "newUsers": sum(1 for p in self.profiles.values() if p.get("isNew")),
                "returningUsers": sum(1 for p in self.profiles.values() if p.get("isReturning")),
                "storage": "内存画像 · 可由持久化层落盘",
            }
        profile = self.identify(user_id)
        return {**profile, "priceSensitivity": self.price_sensitivity(user_id)}
