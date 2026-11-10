import { round, uid } from '../agent_core/util.mjs';

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required };
}

function s(type, description, extra = {}) {
  return { type, description, ...extra };
}

function tool(name, description, category, riskLevel, parameters, handler, extra = {}) {
  return {
    spec: {
      name,
      description,
      category,
      riskLevel,
      parameters,
      version: '1.0.0',
      ...extra
    },
    handler
  };
}

export function createBuiltinTools(runtime) {
  const products = runtime.products;

  return [
    tool(
      'catalog.rank',
      '按品类、预算与历史表现对商品排序，返回可解释的候选清单',
      '商品',
      'low',
      schema(
        {
          category: s('string', '品类过滤，如 绿茶 / 乌龙 / 礼盒'),
          budget: s('number', '单品价格上限'),
          limit: s('number', '返回条数', { default: 3 })
        },
        []
      ),
      async ({ category, budget, limit = 3 }) => {
        const list = products
          .filter((p) => (category ? p.category === category : true))
          .filter((p) => (budget ? p.price <= budget : true))
          .map((p) => ({
            ...p,
            margin: round((p.price - p.cost) / p.price, 3),
            composite: round(p.score * 0.6 + p.demand.cvr * 1000 * 0.3 + p.demand.searchIndex * 0.1, 2)
          }))
          .sort((a, b) => b.composite - a.composite)
          .slice(0, limit);
        return { count: list.length, products: list };
      }
    ),
    tool(
      'catalog.get',
      '读取单个商品的参数、底价、库存与检测信息',
      '商品',
      'low',
      schema({ productId: s('string', '商品 ID') }, ['productId']),
      async ({ productId }) => {
        const product = products.find((p) => p.id === productId);
        if (!product) throw new Error(`Unknown product: ${productId}`);
        return { ...product, margin: round((product.price - product.cost) / product.price, 3) };
      }
    ),
    tool(
      'demand.forecast',
      '基于搜索指数、历史转化与库存估算单品需求区间',
      '数据',
      'low',
      schema({ productId: s('string', '商品 ID') }, ['productId']),
      async ({ productId }) => {
        const product = products.find((p) => p.id === productId);
        if (!product) throw new Error(`Unknown product: ${productId}`);
        const { forecastUnits, cvr, searchIndex, returnRate } = product.demand;
        return {
          productId,
          horizon: '90min',
          forecastUnits,
          expectedOrders: Math.round(forecastUnits * cvr * 100),
          cvr,
          searchIndex,
          returnRate,
          confidence: 0.78,
          method: '梯度提升树 · 同品类历史样本',
          simulation: true
        };
      }
    ),
    tool(
      'schedule.optimize',
      '生成直播节奏排期，按阶段选择话术策略与主推商品',
      '运营',
      'low',
      schema(
        {
          durationMin: s('number', '直播时长（分钟）'),
          targetAov: s('number', '目标客单价')
        },
        ['durationMin']
      ),
      async ({ durationMin = 90, targetAov = 260 }) => {
        const ranked = [...products].sort((a, b) => b.score - a.score);
        const hero = ranked[0];
        const profit = ranked[1];
        const entry = ranked.find((p) => p.category === '礼盒') ?? ranked[4];
        const segments = [
          {
            start: 0,
            end: 12,
            label: '引流预热',
            context: '引流',
            products: [entry.id, hero.id],
            goal: '承接自然流量，建立价格锚点',
            style: runtime.bandit.choose('引流').arm
          },
          {
            start: 12,
            end: Math.round(durationMin * 0.45),
            label: '主推讲解',
            context: '讲解',
            products: [hero.id],
            goal: '用产地、冲泡与检测报告完成信任建立',
            style: runtime.bandit.choose('讲解').arm
          },
          {
            start: Math.round(durationMin * 0.45),
            end: Math.round(durationMin * 0.78),
            label: '矩阵承接',
            context: '讲解',
            products: [profit.id, entry.id],
            goal: `承接不同价格带，抬升客单至 ¥${targetAov}`,
            style: runtime.bandit.choose('讲解').arm
          },
          {
            start: Math.round(durationMin * 0.78),
            end: durationMin,
            label: '返场收口',
            context: '返场',
            products: [entry.id, hero.id],
            goal: '用真实库存与限时权益完成收口',
            style: runtime.bandit.choose('返场').arm
          }
        ];
        return {
          segments,
          totalMinutes: durationMin,
          heroId: hero.id,
          rationale: '礼盒负责新客低门槛，主推单品负责信任与利润，返场用真实库存收口。',
          styleSource: '上下文赌博机 · 按阶段 Thompson 采样'
        };
      }
    ),
    tool(
      'offer.simulate',
      '模拟福利梯度与预算，输出券门槛、数量与预期增益',
      '运营',
      'medium',
      schema(
        {
          targetGmv: s('number', '目标 GMV'),
          aov: s('number', '目标客单价')
        },
        ['targetGmv']
      ),
      async ({ targetGmv = 80000, aov = 260 }) => {
        const orders = Math.ceil(targetGmv / Math.max(aov, 1));
        const coupons = [
          { name: '新客无门槛 ¥10', threshold: 0, amount: 10, quota: 120, purpose: '降低首单门槛' },
          { name: '满 ¥299 减 ¥20', threshold: 299, amount: 20, quota: 80, purpose: '抬升客单价' },
          { name: '返场 ¥15 尝鲜券', threshold: 158, amount: 15, quota: 60, purpose: '收口转化' }
        ];
        const budget = coupons.reduce((sum, c) => sum + c.amount * c.quota, 0);
        return {
          ordersTarget: orders,
          coupons,
          budget,
          budgetRatio: round(budget / Math.max(targetGmv, 1), 4),
          expectedLift: 0.014,
          guardrails: ['单张券需共识审批', '价格不得低于单品底价', '库存数字必须来自 inventory.check'],
          simulation: true
        };
      }
    ),
    tool(
      'script.compose',
      '按意图、商品与赌博机选择的话术风格生成口播稿，并附带数字人指令',
      '内容',
      'low',
      schema(
        {
          intent: s('string', '弹幕意图'),
          productId: s('string', '商品 ID'),
          style: s('string', '话术风格，留空则由赌博机选择'),
          stage: s('string', '直播阶段', { default: '讲解' }),
          reason: s('string', '触发原因')
        },
        ['intent']
      ),
      async ({ intent, productId, style, stage = '讲解', reason }) => {
        const product = products.find((p) => p.id === productId) ?? products[0];
        const selection = style ? { arm: style, context: stage } : runtime.bandit.choose(stage);
        const generated = runtime.llm.compose({
          intent,
          product,
          style: selection.arm,
          stage,
          reason
        });
        const guard = runtime.guardrails.inspectScript(generated.text, { product });
        return {
          ...generated,
          productId: product.id,
          styleContext: stage,
          styleSource: style ? '指定' : 'Thompson Sampling',
          guardrail: guard,
          finalText: guard.pass ? generated.text : guard.rewritten
        };
      }
    ),
    tool(
      'script.compliance',
      '规则引擎强制校验违禁词、极限词、价格与库存口播',
      '合规',
      'low',
      schema(
        {
          text: s('string', '待校验文案'),
          productId: s('string', '关联商品')
        },
        ['text']
      ),
      async ({ text, productId }) => {
        const product = products.find((p) => p.id === productId) ?? null;
        return runtime.guardrails.inspectScript(text, { product });
      }
    ),
    tool(
      'danmaku.classify',
      '识别弹幕意图、情绪、优先级与对应商品',
      '数据',
      'low',
      schema({ text: s('string', '弹幕文本') }, ['text']),
      async ({ text }) => runtime.llm.classify(text)
    ),
    tool(
      'sentiment.analyze',
      '输出情绪分、风险等级与负面原因，用于实时场控',
      '数据',
      'low',
      schema({ text: s('string', '弹幕文本') }, ['text']),
      async ({ text }) => {
        const c = runtime.llm.classify(text);
        return {
          sentiment: c.sentiment,
          risk: c.risk,
          intent: c.intent,
          reasons: c.reasons,
          requiresEscalation: c.risk === 'high' && c.sentiment < -0.6
        };
      }
    ),
    tool(
      'inventory.check',
      '读取实时库存与安全库存，供场控与话术引用',
      '数据',
      'low',
      schema({ productId: s('string', '商品 ID') }, ['productId']),
      async ({ productId }) => {
        const product = products.find((p) => p.id === productId);
        if (!product) throw new Error(`Unknown product: ${productId}`);
        return {
          productId,
          stock: product.stock,
          safetyStock: Math.round(product.stock * 0.18),
          status: product.stock < 100 ? 'tight' : 'healthy',
          source: 'WMS 实时快照（演示）',
          checkedAt: Date.now()
        };
      }
    ),
    tool(
      'price.guard',
      '校验目标价格是否低于底价或超过单场折扣上限',
      '合规',
      'medium',
      schema(
        {
          productId: s('string', '商品 ID'),
          price: s('number', '目标价格')
        },
        ['productId', 'price']
      ),
      async ({ productId, price }) => {
        const product = products.find((p) => p.id === productId);
        return { productId, targetPrice: price, ...runtime.guardrails.checkPrice(product, price) };
      }
    ),
    tool(
      'memory.recall',
      '先检索情景记忆与知识图谱，再交给生成模型，降低幻觉',
      '记忆',
      'low',
      schema(
        {
          query: s('string', '检索问题'),
          limit: s('number', '返回条数', { default: 3 })
        },
        ['query']
      ),
      async ({ query, limit = 3 }) => {
        const hits = runtime.memory.recall(query, limit);
        return {
          query,
          hits,
          count: hits.length,
          strategy: '字符 n-gram 余弦 + 时间衰减 · 本地仿真检索',
          graph: runtime.memory.semanticQuery(query)
        };
      }
    ),
    tool(
      'metrics.snapshot',
      '读取当前场次的实时经营指标',
      '数据',
      'low',
      schema({}, []),
      async () => runtime.getMetrics()
    ),
    tool(
      'causal.attribution',
      '对当前场次的干预做 ATT 估计、置信区间与显著性检验',
      '分析',
      'low',
      schema({ intervention: s('string', '干预名称') }, []),
      async ({ intervention }) => runtime.computeCausal(intervention)
    ),
    tool(
      'human.escalate',
      '将无法消解的冲突升级给人工，生成工单并冻结高风险动作',
      '运营',
      'medium',
      schema(
        {
          reason: s('string', '升级原因'),
          proposal: s('object', '待人工复核的提案')
        },
        ['reason']
      ),
      async ({ reason, proposal = null }) => {
        const ticket = {
          id: uid('HITL'),
          reason,
          proposal,
          status: 'open',
          createdAt: Date.now(),
          slaSeconds: 120
        };
        runtime.humanQueue.unshift(ticket);
        runtime.emit('human.escalated', ticket);
        return ticket;
      }
    ),
    tool(
      'digital_human.direct',
      '把口播稿转成数字人情绪、手势、语速与字幕指令',
      '内容',
      'low',
      schema(
        {
          script: s('string', '口播稿'),
          emotion: s('string', '情绪')
        },
        ['script']
      ),
      async ({ script, emotion = 'warm' }) => {
        const pace = /检测|农残|合规/.test(script) ? 'slow' : /库存|倒计时/.test(script) ? 'fast' : 'normal';
        return {
          avatar: 'shanyin-01',
          emotion,
          gesture: /报告|检测/.test(script) ? 'show_report' : /库存|倒计时/.test(script) ? 'point_timer' : 'open_hands',
          speechRate: pace,
          subtitleCps: pace === 'fast' ? 6.2 : pace === 'slow' ? 3.8 : 4.8,
          subtitle: script.slice(0, 56),
          renderMode: 'streaming · 演示'
        };
      }
    ),
    tool(
      'coupon.issue',
      '发放优惠券。高风险动作，必须携带有效共识审批 ID',
      '运营',
      'high',
      schema(
        {
          amount: s('number', '券面额'),
          threshold: s('number', '使用门槛'),
          approvalId: s('string', '共识审批 ID')
        },
        ['amount', 'threshold']
      ),
      async ({ amount, threshold, approvalId }) => {
        const label = threshold > 0 ? `满 ¥${threshold} 减 ¥${amount}` : `¥${amount} 无门槛券`;
        const coupon = {
          id: uid('CPN'),
          amount,
          threshold,
          approvalId,
          issuedAt: Date.now(),
          status: 'active',
          label,
          source: '共识审批后发放'
        };
        runtime.coupon = coupon;
        runtime.blackboard.update({ couponActive: true });
        runtime.emit('coupon.issued', coupon);
        return coupon;
      },
      { requiresApproval: true }
    ),
    tool(
      'pricing.change',
      '调整商品价格。红线动作，必须通过共识审批且高于底价',
      '运营',
      'critical',
      schema(
        {
          productId: s('string', '商品 ID'),
          price: s('number', '目标价格'),
          approvalId: s('string', '共识审批 ID')
        },
        ['productId', 'price']
      ),
      async ({ productId, price, approvalId }) => {
        const product = products.find((p) => p.id === productId);
        const check = runtime.guardrails.checkPrice(product, price);
        if (!check.pass) throw new Error(check.reason);
        runtime.emit('price.changed', { productId, price, approvalId });
        return {
          productId,
          from: product.price,
          to: price,
          approvalId,
          discount: round(1 - price / product.price, 4),
          appliedAt: Date.now()
        };
      },
      { requiresApproval: true }
    )
  ];
}

export function createHotplugTool({ name, description, category = '扩展', handlerType, riskLevel = 'low' }) {
  const handlers = {
    market_compare: async ({ productId = 'P-01' }) => ({
      productId,
      samples: [
        { channel: '同产区品牌店', price: 398 },
        { channel: '内容电商中位价', price: 328 },
        { channel: '本场价', price: 299 }
      ],
      median: 328,
      note: '竞品比价 · 演示数据',
      source: 'hotplug:market.compare'
    }),
    audience_weather: async ({ hour = new Date().getHours() }) => ({
      hour,
      index: hour >= 19 && hour <= 22 ? 0.92 : hour >= 12 && hour <= 14 ? 0.61 : 0.42,
      label: hour >= 19 && hour <= 22 ? '夜间高活跃' : '常规活跃',
      note: '人群活跃度 · 演示数据',
      source: 'hotplug:audience.weather'
    }),
    margin_calc: async ({ price = 299, cost = 168 }) => ({
      price,
      cost,
      grossMargin: round((price - cost) / price, 4),
      breakEvenUnits: Math.ceil(1200 / Math.max(price - cost, 1)),
      note: '毛利测算 · 演示数据',
      source: 'hotplug:margin.calc'
    })
  };
  const handler = handlers[handlerType];
  if (!handler) throw new Error(`Unknown hotplug handler: ${handlerType}`);
  return tool(
    name,
    description,
    category,
    riskLevel,
    schema({ productId: s('string', '商品 ID'), hour: s('number', '小时'), price: s('number', '价格'), cost: s('number', '成本') }, []),
    handler,
    { source: 'hotplug', handlerType }
  );
}
