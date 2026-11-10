import { mulberry32, round } from '../agent_core/util.mjs';

// Beta 分布采样：用两段 Gamma 采样近似，避免外部依赖。
function gammaSample(k, rng) {
  if (k < 1) {
    const u = rng();
    return gammaSample(1 + k, rng) * u ** (1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = normalSample(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function betaSample(a, b, rng) {
  const x = gammaSample(a, rng);
  const y = gammaSample(b, rng);
  return x / (x + y);
}

export class BetaBandit {
  constructor({ contexts, arms, seed = 20261108, prior = null } = {}) {
    this.contexts = contexts;
    this.arms = arms;
    this.rng = mulberry32(seed);
    this.seed = seed;
    this.posteriors = {};
    this.updates = 0;
    this.history = [];
    for (const context of contexts) {
      this.posteriors[context] = arms.map((arm, index) => ({
        arm,
        alpha: prior?.[context]?.[index]?.[0] ?? 1,
        beta: prior?.[context]?.[index]?.[1] ?? 1
      }));
    }
  }

  choose(context = this.contexts[0]) {
    const row = this.posteriors[context] ?? this.posteriors[this.contexts[0]];
    const samples = row.map((cell) => ({
      arm: cell.arm,
      sample: betaSample(cell.alpha, cell.beta, this.rng)
    }));
    samples.sort((a, b) => b.sample - a.sample);
    return {
      context,
      arm: samples[0].arm,
      sample: round(samples[0].sample, 4),
      exploration: round(samples[0].sample - (samples[1]?.sample ?? 0), 4),
      ranking: samples.map((s) => ({ arm: s.arm, sample: round(s.sample, 4) }))
    };
  }

  update(context, arm, reward) {
    const row = this.posteriors[context] ?? this.posteriors[this.contexts[0]];
    const cell = row.find((c) => c.arm === arm);
    if (!cell) return null;
    if (reward) cell.alpha += 1;
    else cell.beta += 1;
    this.updates += 1;
    this.history.unshift({ context, arm, reward: Boolean(reward), at: Date.now() });
    if (this.history.length > 120) this.history.pop();
    return cell;
  }

  best(context) {
    const row = this.posteriors[context] ?? [];
    return [...row]
      .map((c) => ({
        ...c,
        mean: c.alpha / (c.alpha + c.beta)
      }))
      .sort((a, b) => b.mean - a.mean)[0];
  }

  snapshot() {
    const contexts = this.contexts.map((context) => ({
      context,
      arms: this.posteriors[context].map((c) => ({
        arm: c.arm,
        alpha: c.alpha,
        beta: c.beta,
        mean: round(c.alpha / (c.alpha + c.beta), 3),
        observations: c.alpha + c.beta - 2
      })),
      chosen: this.choose(context).arm
    }));
    return {
      contexts,
      updates: this.updates,
      recent: this.history.slice(0, 6),
      policy: 'Beta Thompson Sampling · 上下文 = 直播阶段'
    };
  }
}

export { betaSample };
