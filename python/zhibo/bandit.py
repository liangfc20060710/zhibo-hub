from __future__ import annotations

import math

from .util import Rng, now_ms, round_to


def normal_sample(rng):
    u = 0.0
    while u == 0:
        u = rng()
    v = 0.0
    while v == 0:
        v = rng()
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)


def gamma_sample(shape, rng):
    if shape < 1:
        u = rng()
        return gamma_sample(1 + shape, rng) * (u ** (1 / shape))
    d = shape - 1 / 3
    c = 1 / math.sqrt(9 * d)
    while True:
        while True:
            x = normal_sample(rng)
            v = 1 + c * x
            if v > 0:
                break
        v = v ** 3
        u = rng()
        if u < 1 - 0.0331 * x ** 4:
            return d * v
        if math.log(u) < 0.5 * x * x + d * (1 - v + math.log(v)):
            return d * v


def beta_sample(alpha, beta, rng):
    x = gamma_sample(alpha, rng)
    y = gamma_sample(beta, rng)
    return x / (x + y)


def _prior_value(pair, index, default):
    value = None
    if isinstance(pair, dict):
        value = pair.get(index)
    elif pair is not None and index < len(pair):
        value = pair[index]
    return default if value is None else value


class BetaBandit:
    def __init__(self, options=None, *, contexts=None, arms=None, seed=20261108, prior=None,
                 **aliases):
        merged = dict(options) if isinstance(options, dict) else {}
        merged.update(aliases)
        self.contexts = merged.get("contexts", contexts) or []
        self.arms = merged.get("arms", arms) or []
        self.rng = Rng(merged.get("seed", seed))
        self.seed = merged.get("seed", seed)
        self.posteriors = {}
        self.updates = 0
        self.history = []
        prior = merged.get("prior", prior)
        prior = prior if isinstance(prior, dict) else {}
        for context in self.contexts:
            rows = prior.get(context)
            rows = rows if rows is not None else []
            self.posteriors[context] = [
                {
                    "arm": arm,
                    "alpha": _prior_value(rows[index] if index < len(rows) else None, 0, 1),
                    "beta": _prior_value(rows[index] if index < len(rows) else None, 1, 1),
                }
                for index, arm in enumerate(self.arms)
            ]

    def _row(self, context=None):
        row = self.posteriors.get(context)
        if row is None and self.contexts:
            row = self.posteriors.get(self.contexts[0])
        return row if row is not None else []

    def choose(self, context=None):
        if context is None:
            context = self.contexts[0] if self.contexts else None
        samples = [
            {"arm": cell["arm"], "sample": beta_sample(cell["alpha"], cell["beta"], self.rng)}
            for cell in self._row(context)
        ]
        samples = sorted(samples, key=lambda entry: entry["sample"], reverse=True)
        leader = samples[0]
        runner_up = samples[1]["sample"] if len(samples) > 1 else 0
        return {
            "context": context,
            "arm": leader["arm"],
            "sample": round_to(leader["sample"], 4),
            "exploration": round_to(leader["sample"] - runner_up, 4),
            "ranking": [
                {"arm": entry["arm"], "sample": round_to(entry["sample"], 4)} for entry in samples
            ],
        }

    def update(self, context, arm, reward):
        row = self._row(context)
        cell = next((entry for entry in row if entry["arm"] == arm), None)
        if cell is None:
            return None
        if reward:
            cell["alpha"] += 1
        else:
            cell["beta"] += 1
        self.updates += 1
        self.history.insert(0, {
            "context": context,
            "arm": arm,
            "reward": bool(reward),
            "at": now_ms(),
        })
        if len(self.history) > 120:
            self.history.pop()
        return cell

    def best(self, context):
        row = self.posteriors.get(context)
        ranked = sorted(
            [
                {**cell, "mean": cell["alpha"] / (cell["alpha"] + cell["beta"])}
                for cell in (row if row is not None else [])
            ],
            key=lambda cell: cell["mean"],
            reverse=True,
        )
        return ranked[0] if ranked else None

    def snapshot(self):
        contexts = [
            {
                "context": context,
                "arms": [
                    {
                        "arm": cell["arm"],
                        "alpha": cell["alpha"],
                        "beta": cell["beta"],
                        "mean": round_to(cell["alpha"] / (cell["alpha"] + cell["beta"]), 3),
                        "observations": cell["alpha"] + cell["beta"] - 2,
                    }
                    for cell in self.posteriors.get(context, [])
                ],
                "chosen": self.choose(context)["arm"],
            }
            for context in self.contexts
        ]
        return {
            "contexts": contexts,
            "updates": self.updates,
            "recent": self.history[:6],
            "policy": "Beta Thompson Sampling · 上下文 = 直播阶段",
        }
