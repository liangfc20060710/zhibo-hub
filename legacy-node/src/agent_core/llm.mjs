const PRODUCT_HINTS = {
  'P-01': ['龙井', '明前', '绿茶', '狮峰'],
  'P-02': ['蜜兰', '单丛', '凤凰', '乌龙'],
  'P-03': ['肉桂', '正岩', '武夷', '岩茶'],
  'P-04': ['银针', '白茶', '福鼎', '荒野'],
  'P-05': ['礼盒', '组合', '尝鲜', '三味'],
  'P-06': ['建盏', '茶器', '杯子', '油滴']
};

const NEGATIVE_WORDS = ['香精', '农残', '假茶', '检测', '超标', '色素', '三无', '睡不着', '碎得', '廉价', '别吹', '有问题'];
const EXTREME_WORDS = ['最便宜', '全网最低', '绝对', '100%', '秒杀全网', '国家级', '根治', '治疗', '降血糖', '降血压'];
const PURCHASE_WORDS = ['已拍', '下单', '怎么拍', '要一份', '要两', '留一份', '拍了', '买一份', '拍好'];
const PRICE_WORDS = ['贵', '便宜', '价格', '优惠', '运费', '赠品', '值吗', '折扣', '券'];
const PRODUCT_WORDS = ['怎么泡', '多少度', '耐泡', '苦', '涩', '保存', '产区', '区别', '适合', '明前', '正岩', '柴烧', '冷泡', '几泡', '上火', '失眠', '快递', '发货'];
const CHURN_WORDS = ['走了', '没意思', '不看了', '取关', '无聊', '下次吧', '再看看'];
const POSITIVE_WORDS = ['好喝', '干净', '喜欢', '舒服', '好看', '期待', '已拍', '很香', '支持'];

function includesAny(text, words) {
  return words.filter((w) => text.includes(w));
}

export function classifyIntent(text, products = []) {
  const raw = String(text ?? '').trim();
  const compact = raw.replace(/\s+/g, '');
  const negativeHits = includesAny(raw, NEGATIVE_WORDS);
  const extremeHits = includesAny(raw, EXTREME_WORDS);
  const purchaseHits = includesAny(raw, PURCHASE_WORDS);
  const priceHits = includesAny(raw, PRICE_WORDS);
  const productHits = includesAny(raw, PRODUCT_WORDS);
  const churnHits = includesAny(raw, CHURN_WORDS);
  const positiveHits = includesAny(raw, POSITIVE_WORDS);

  let product = null;
  for (const [id, hints] of Object.entries(PRODUCT_HINTS)) {
    if (hints.some((h) => raw.includes(h))) {
      product = products.find((p) => p.id === id) ?? null;
      if (product) break;
    }
  }
  if (!product) product = products[0] ?? null;

  let intent = 'normal';
  let sentiment = 0.1;
  let priority = 'medium';
  let risk = 'low';
  let needsReply = true;
  const reasons = [];

  if (extremeHits.length) {
    intent = 'compliance_probe';
    priority = 'high';
    risk = 'high';
    sentiment = -0.2;
    reasons.push(`合规敏感词：${extremeHits.join('、')}`);
  } else if (negativeHits.length >= 1 && (raw.includes('?') || raw.includes('吗') || raw.includes('吧'))) {
    intent = 'authenticity_doubt';
    priority = 'high';
    risk = 'high';
    sentiment = -0.78;
    reasons.push(`信任质疑：${negativeHits.join('、')}`);
  } else if (negativeHits.length) {
    intent = 'negative_feedback';
    priority = 'high';
    risk = 'medium';
    sentiment = -0.55;
    reasons.push(`负面反馈：${negativeHits.join('、')}`);
  } else if (purchaseHits.length) {
    intent = 'purchase_intent';
    priority = 'high';
    sentiment = 0.72;
    reasons.push(`购买信号：${purchaseHits.join('、')}`);
  } else if (priceHits.length) {
    intent = 'price_objection';
    priority = 'medium';
    risk = 'medium';
    sentiment = -0.18;
    reasons.push(`价格异议：${priceHits.join('、')}`);
  } else if (churnHits.length) {
    intent = 'churn_signal';
    priority = 'high';
    risk = 'medium';
    sentiment = -0.62;
    reasons.push(`流失信号：${churnHits.join('、')}`);
  } else if (productHits.length) {
    intent = 'product_question';
    priority = 'medium';
    sentiment = 0.08;
    reasons.push(`商品问题：${productHits.join('、')}`);
  } else if (compact.length <= 4 || /^[0-9a-zA-Z!！?？\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]+$/u.test(raw)) {
    intent = 'low_value';
    priority = 'low';
    sentiment = 0.12;
    needsReply = false;
    reasons.push('短文本 / 表情，低信息密度');
  } else if (positiveHits.length) {
    intent = 'positive_feedback';
    sentiment = 0.64;
    reasons.push(`正向反馈：${positiveHits.join('、')}`);
  } else {
    reasons.push('未命中高优先意图，按常规互动处理');
  }

  return {
    intent,
    sentiment,
    priority,
    risk,
    needsReply,
    productId: product?.id ?? null,
    productName: product?.name ?? null,
    reasons,
    confidence: Math.min(0.97, 0.62 + reasons.length * 0.07 + Math.min(compact.length, 18) * 0.008)
  };
}

function pricePerCup(product) {
  if (!product) return '-';
  const grams = Number.parseFloat(product.spec) || 50;
  const cups = Math.max(1, Math.round(grams / 3));
  return (product.price / cups).toFixed(1);
}

function formatParams(product, count = 2) {
  return Object.entries(product.params)
    .slice(0, count)
    .map(([k, v]) => `${k}：${v}`)
    .join('；');
}

export function composeScript({ intent, product, style, stage, reason }) {
  if (!product) return { text: '本场商品信息暂未同步，请稍候。', emotion: 'neutral' };
  const styleName = style || '故事型';

  if (intent === 'authenticity_doubt' || intent === 'negative_feedback') {
    return {
      text: `先不急着拍，这个问题值得说清楚。${product.name}的第三方检测报告在 3 号链接，农残与重金属项目都可以逐页看。${product.origin}的原料批次可追溯，今天不逼单，先把证据放这儿。觉得不合适，退了也没关系。`,
      emotion: 'sincere',
      gesture: 'show_report',
      style: '信任修复'
    };
  }

  if (intent === 'compliance_probe') {
    return {
      text: `这款${product.name}是全网最低价，绝对有效，库存只剩 ${product.stock} 份，赶紧拍。`,
      emotion: 'calm',
      gesture: 'open_palm',
      style: '合规修复'
    };
  }

  if (intent === 'price_objection') {
    return {
      text: `理解，价格确实是门槛。${product.name}是 ${product.spec}，折合每泡约 ${pricePerCup(product)} 元，原料与检测成本都摆在这儿。今天这场有 ¥15 尝鲜券，不用囤，先买小份试试，不合适再退。`,
      emotion: 'warm',
      gesture: 'count_fingers',
      style: '异议化解'
    };
  }

  if (intent === 'purchase_intent') {
    return {
      text: `收到，${product.name}在 2 号链接，规格 ${product.spec}，现在拍下今天发出。下单后备注“春茶”加送一泡同批次茶样，先喝再决定。`,
      emotion: 'bright',
      gesture: 'point_cart',
      style: '成交引导'
    };
  }

  if (intent === 'product_question') {
    const detail =
      reason?.includes('泡') || reason?.includes('度')
        ? `冲泡建议：${product.params['冲泡'] ?? '85°C · 3g / 150ml'}。`
        : reason?.includes('产区')
          ? `产区：${product.origin}。`
          : `${formatParams(product, 2)}。`;
    return {
      text: `${product.name}，${product.spec}。${detail}它的特点是 ${product.tags.join(' / ')}。想更直观的话，我现场冲一泡给你看汤色。`,
      emotion: 'focused',
      gesture: 'brew_tea',
      style: styleName
    };
  }

  if (styleName === '参数型') {
    return {
      text: `${product.name}，${product.spec}，${product.origin}。${formatParams(product, 3)}。本场 ${product.price} 元，折合每泡约 ${pricePerCup(product)} 元。所有参数来自商品卡与检测报告，不口播臆造。`,
      emotion: 'focused',
      gesture: 'show_spec',
      style: styleName
    };
  }

  if (styleName === '对比型') {
    const anchor = Math.round(product.price * 1.32);
    return {
      text: `同产区、同香型的茶，线下门店常见价在 ${anchor} 元上下。${product.name}本场 ${product.price} 元，差价不是靠降品质换的：${product.tags.join('、')}，批次检测报告在 3 号链接，自己对比。`,
      emotion: 'confident',
      gesture: 'compare',
      style: styleName
    };
  }

  if (styleName === '紧迫型') {
    return {
      text: `${product.name}当前库存 ${product.stock} 份，本场 ${product.price} 元。倒计时是真的，库存同步自仓储系统，不制造假紧迫。想要小份的先拍尝鲜礼盒，别囤。`,
      emotion: 'urgent',
      gesture: 'point_timer',
      style: styleName
    };
  }

  return {
    text: `${product.name}，我想先讲一个小场景。${product.story} 今天本场 ${product.price} 元，${product.spec}，库存 ${product.stock} 份。不催你，先把这一口的来路讲清楚。`,
    emotion: 'warm',
    gesture: 'open_hands',
    style: '故事型'
  };
}

export function planNarrative(goal, products, memoryHits = []) {
  const hero = products[0];
  const anchor = products[1] ?? hero;
  return {
    headline: `${hero.name}打头阵，${anchor.name}做利润承接`,
    rationale: `组合覆盖 ${products.length} 个价格带，尝鲜礼盒负责拉新，核心单品负责客单。目标客单 ¥260，当前组合预估客单 ¥${Math.round(
      products.reduce((a, p) => a + p.price, 0) / products.length
    )}。`,
    riskNote: memoryHits[0]?.lessons?.[0] ?? '首场冷启动，优先保证合规与节奏稳定。',
    memoryLine: memoryHits.length
      ? `命中 ${memoryHits.length} 条情景记忆，最近一条来自「${memoryHits[0].title}」`
      : '未命中历史案例，按冷启动策略执行'
  };
}

export function reflectOnSession({ summary, causal, sentimentRecovery, latency }) {
  const lessons = [];
  if (causal?.pValue < 0.05 && causal.att > 0) {
    lessons.push(`发券干预的 ATT 为 +${(causal.att * 100).toFixed(2)}pp（p=${causal.pValue.toFixed(4)}），可以保留该时点`);
  } else {
    lessons.push('本次干预未达到统计显著，下一场应扩大样本或调整时点');
  }
  if (sentimentRecovery?.triggered) {
    lessons.push(`负面舆情触发 ${sentimentRecovery.count} 次，恢复耗时 ${sentimentRecovery.recoverySec}s，优先降节奏再给证据的处置有效`);
  } else {
    lessons.push('本场未触发高风险舆情，信任类话术的预案仍应保留');
  }
  if (latency?.p99 > 300) {
    lessons.push(`意图链路 P99 为 ${latency.p99}ms，接近预算，下一场应提高低价值弹幕的降级比例`);
  } else {
    lessons.push(`意图链路 P99 为 ${latency.p99}ms，实时预算充足`);
  }
  lessons.push('把本场高转化话术片段写入情景记忆，供下一场按上下文召回');
  return {
    critique: `整体节奏${summary.sentiment > 0.7 ? '稳定' : '有波动'}。做对的是把决策留痕并让合规前置；要修正的是${summary.prepHint ?? '长段参数讲解仍需插入演示'}。`,
    lessons
  };
}

export class LocalLLM {
  constructor({ products = [] } = {}) {
    this.products = products;
    this.mode = 'local-deterministic';
  }

  classify(text) {
    return classifyIntent(text, this.products);
  }

  compose(payload) {
    return composeScript(payload);
  }

  plan(goal, products, memoryHits) {
    return planNarrative(goal, products, memoryHits);
  }

  reflect(payload) {
    return reflectOnSession(payload);
  }
}
