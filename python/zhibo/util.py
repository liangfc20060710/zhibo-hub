from __future__ import annotations

import math
import secrets
import threading
import time

_seq_lock = threading.Lock()
_seq = 0
_DIGITS36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def base36(value: int, width: int = 3) -> str:
    if value == 0:
        return "0" * width
    out: list[str] = []
    while value:
        value, rem = divmod(value, 36)
        out.append(_DIGITS36[rem])
    return "".join(reversed(out)).rjust(width, "0")


def uid(prefix: str = "ID") -> str:
    global _seq
    with _seq_lock:
        _seq += 1
        value = _seq
    return f"{prefix}-{base36(value, 3)}-{secrets.token_hex(2)}"


def trace_code() -> str:
    return f"TRC-{secrets.token_hex(3).upper()}"


def uint32(value: int) -> int:
    return value & 0xFFFFFFFF


def int32(value: int) -> int:
    value = uint32(value)
    return value - 0x100000000 if value >= 0x80000000 else value


def imul32(a: int, b: int) -> int:
    return uint32(int32(a) * int32(b))


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def round_to(value: float, digits: int = 1) -> float:
    factor = 10**digits
    return math.floor(value * factor + 0.5) / factor


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = int(clamp(math.ceil((p / 100) * len(ordered)) - 1, 0, len(ordered) - 1))
    return ordered[index]


def now_ms() -> int:
    return int(time.time() * 1000)


def sleep_ms(ms: float) -> None:
    time.sleep(max(0, ms) / 1000)


class Rng:
    """Exact JavaScript mulberry32 port."""

    def __init__(self, seed: int) -> None:
        self._state = uint32(seed)

    def next(self) -> float:
        a = int32(uint32(self._state) + 0x6D2B79F5)
        self._state = a
        t = imul32(a ^ (uint32(a) >> 15), 1 | a)
        t = uint32(t + imul32(t ^ (uint32(t) >> 7), 61 | t)) ^ t
        return uint32(t ^ (uint32(t) >> 14)) / 4294967296

    __call__ = next


def hash_string(value: str) -> int:
    h = 2166136261
    for char in value:
        h ^= ord(char)
        h = imul32(h, 16777619)
    return uint32(h)


def erf(value: float) -> float:
    sign = -1 if value < 0 else 1
    ax = abs(value)
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    t = 1 / (1 + p * ax)
    y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * math.exp(-ax * ax)
    return sign * y


def normal_cdf(z: float) -> float:
    return 0.5 * (1 + erf(z / math.sqrt(2)))


def two_proportion_test(success_a: int, total_a: int, success_b: int, total_b: int) -> dict:
    rate_a = success_a / total_a if total_a else 0
    rate_b = success_b / total_b if total_b else 0
    diff = rate_a - rate_b
    se = math.sqrt((rate_a * (1 - rate_a)) / max(total_a, 1) + (rate_b * (1 - rate_b)) / max(total_b, 1))
    z = diff / se if se else 0
    p_value = 2 * (1 - normal_cdf(abs(z)))
    margin = 1.96 * se
    return {
        "rateA": rate_a,
        "rateB": rate_b,
        "diff": diff,
        "se": se,
        "z": z,
        "pValue": p_value,
        "ci95": [diff - margin, diff + margin],
        "relative": diff / rate_b if rate_b else 0,
    }


def format_timestamp(timestamp: int | None = None) -> str:
    value = timestamp if timestamp is not None else now_ms()
    return time.strftime("%H:%M:%S", time.localtime(value / 1000))
