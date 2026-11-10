import { mulberry32, round, twoProportionTest } from '../agent_core/util.mjs';

export class CausalEngine {
  constructor({ seed = 20261108 } = {}) {
    this.seed = seed;
    this.rng = mulberry32(seed);
  }

  analyze({ intervention, treated, control, method = '随机分流 A/B · 两比例 z 检验' }) {
    const stat = twoProportionTest({
      successA: treated.conversions,
      totalA: treated.n,
      successB: control.conversions,
      totalB: control.n
    });
    const significant = stat.pValue < 0.05 && (stat.ci95[0] > 0 || stat.ci95[1] < 0);
    return {
      intervention,
      method,
      treated,
      control,
      att: round(stat.diff, 6),
      relative: round(stat.relative, 6),
      pValue: round(stat.pValue, 6),
      ci95: [round(stat.ci95[0], 6), round(stat.ci95[1], 6)],
      z: round(stat.z, 3),
      significant,
      verdict: significant ? (stat.diff > 0 ? '显著为正' : '显著为负') : '未达显著',
      statement: `因为「${intervention}」，转化率变化 ${stat.diff >= 0 ? '+' : ''}${(stat.diff * 100).toFixed(
        2
      )}pp（95% CI ${(stat.ci95[0] * 100).toFixed(2)}pp ~ ${(stat.ci95[1] * 100).toFixed(
        2
      )}pp，p=${stat.pValue.toFixed(4)}）。`,
      simulation: true
    };
  }

  simulateExperiment({
    intervention = '第 52 分钟发放 ¥15 无门槛券',
    n = 2800,
    baseRate = 0.032,
    effect = 0.014,
    seed = 20261108
  } = {}) {
    const rng = mulberry32(seed);
    const draw = (p, count) => {
      let successes = 0;
      for (let i = 0; i < count; i += 1) {
        if (rng() < p) successes += 1;
      }
      return successes;
    };
    const treated = { n, conversions: draw(baseRate + effect, n) };
    const control = { n, conversions: draw(baseRate, n) };
    return this.analyze({ intervention, treated, control, method: '随机分流 A/B · 本机仿真样本' });
  }

  dag(intervention = '发券') {
    return {
      intervention,
      nodes: [
        { id: 'traffic', label: '自然流量', type: 'context', note: '时段 / 推荐位 / 粉丝回访' },
        { id: 'coupon', label: intervention, type: 'treatment', note: 'do(coupon=1)' },
        { id: 'dwell', label: '停留时长', type: 'mediator', note: '讲解完成度 / 节奏' },
        { id: 'interaction', label: '互动行为', type: 'mediator', note: '提问 / 点击 / 加购' },
        { id: 'conversion', label: '成交转化', type: 'outcome', note: '下单 / 支付' }
      ],
      edges: [
        { from: 'traffic', to: 'dwell', label: '选择偏差' },
        { from: 'traffic', to: 'conversion', label: '自然波动' },
        { from: 'coupon', to: 'dwell', label: '权益感知' },
        { from: 'dwell', to: 'interaction', label: '内容承接' },
        { from: 'interaction', to: 'conversion', label: '意图形成' },
        { from: 'coupon', to: 'conversion', label: '直接作用' }
      ],
      note: '以随机分流切断「流量 → 干预」的混杂路径，ATT 在可比样本上估计。'
    };
  }
}
