import { createEnvelope } from '../a2a_layer/envelope.mjs';
import { round, uid } from '../agent_core/util.mjs';

export class Actor {
  constructor({
    id,
    logicalRole,
    name,
    title,
    latin,
    description,
    accent,
    capabilities,
    weight,
    cognition,
    tools = [],
    runtime,
    bus,
    canBid = true,
    replicaOf = null,
    standby = false
  }) {
    this.id = id;
    this.logicalRole = logicalRole;
    this.name = name;
    this.title = title;
    this.latin = latin;
    this.description = description;
    this.accent = accent;
    this.capabilities = capabilities;
    this.weight = weight;
    this.cognition = cognition;
    this.tools = tools;
    this.runtime = runtime;
    this.bus = bus;
    this.canBid = canBid;
    this.replicaOf = replicaOf;
    this.status = standby ? 'standby' : 'active';
    this.mailbox = [];
    this.processing = false;
    this.load = 0.12;
    this.reliability = replicaOf ? 0.95 : 0.97;
    this.handled = 0;
    this.received = 0;
    this.lastEnvelope = null;
    this.lastAction = standby ? '热备待命' : '等待任务';
    this.lastActionAt = null;
    this.recentEnvelopes = [];
    this.currentTask = null;
  }

  async enqueue(envelope) {
    this.received += 1;
    this.lastEnvelope = envelope;
    this.mailbox.push(envelope);
    if (this.mailbox.length > 80) this.mailbox.shift();
    this.load = Math.min(0.92, 0.16 + this.mailbox.length * 0.09);
    this.runtime.emit('agent', this.snapshot());
    void this.drain();
  }

  async drain() {
    if (this.processing || this.status !== 'active') return;
    this.processing = true;
    this.load = Math.max(this.load, 0.38);
    while (this.mailbox.length && this.status === 'active') {
      const envelope = this.mailbox.shift();
      try {
        await this.handle(envelope);
      } catch (error) {
        this.runtime.emit('agent.error', { agent: this.id, message: error.message, traceId: envelope.traceId });
      }
      this.handled += 1;
      this.load = Math.max(0.12, Math.min(0.9, 0.2 + this.mailbox.length * 0.1));
      this.runtime.emit('agent', this.snapshot());
    }
    this.processing = false;
    this.load = 0.12;
  }

  async handle(envelope) {
    this.currentTask = `${envelope.performative} · ${envelope.content?.capability ?? envelope.content?.kind ?? 'message'}`;
    this.recentEnvelopes.unshift({
      performative: envelope.performative,
      from: envelope.sender,
      at: envelope.createdAt,
      traceId: envelope.traceId
    });
    this.recentEnvelopes = this.recentEnvelopes.slice(0, 6);
    if (envelope.performative === 'CFP') return this.onCfp(envelope);
    if (envelope.performative === 'AWARD') return this.onAward(envelope);
    if (envelope.performative === 'VOTE') return this.onVote(envelope);
    if (envelope.performative === 'REQUEST') return this.onRequest(envelope);
    if (envelope.performative === 'INFORM') return this.onInform(envelope);
    return null;
  }

  async onCfp(envelope) {
    if (!this.canBid) return null;
    const capability = envelope.content?.capability ?? 'general';
    const capabilityScore = this.capabilities[capability] ?? 0.2;
    const score = round(capabilityScore * 0.62 + (1 - this.load) * 0.23 + this.reliability * 0.15, 4);
    this.lastAction = `投标 ${capability} · 评分 ${score}`;
    this.lastActionAt = Date.now();
    await this.bus.send(
      createEnvelope({
        sender: this.id,
        receiver: envelope.sender,
        performative: 'PROPOSE',
        traceId: envelope.traceId,
        inReplyTo: envelope.msgId,
        content: {
          capability,
          task: envelope.content?.task,
          score,
          breakdown: {
            capability: round(capabilityScore, 3),
            availability: round(1 - this.load, 3),
            reliability: this.reliability
          },
          load: round(this.load, 3),
          etaMs: Math.round(180 + this.load * 420),
          reason: this.bidReason(capability)
        }
      })
    );
  }

  bidReason(capability) {
    const labels = {
      planning: '选品与排期模型命中度最高',
      realtime: '流式意图分类实例空闲',
      copy: '话术风格库与数字人指令完整',
      attribution: '因果图与 A/B 引擎就绪'
    };
    return labels[capability] ?? '通用能力可用';
  }

  async onAward(envelope) {
    this.lastAction = `中标：${envelope.content?.task ?? '任务'}`;
    this.lastActionAt = Date.now();
    this.currentTask = envelope.content?.task ?? null;
    this.runtime.emit('agent', this.snapshot());
  }

  evaluateProposal(proposal) {
    const evidenceCount = proposal.evidence?.length ?? 0;
    const impact = proposal.expectedImpact ?? 0;
    const approve = evidenceCount >= 2 && impact >= 0;
    return {
      approve,
      rationale: approve
        ? `证据 ${evidenceCount} 条，预期增益 ${(impact * 100).toFixed(1)}pp，风险可控`
        : `证据不足或预期增益为负，选择否决`
    };
  }

  async onVote(envelope) {
    const proposal = envelope.content?.proposal ?? {};
    const evaluation = this.evaluateProposal(proposal);
    this.lastAction = `投票：${evaluation.approve ? '赞成' : '否决'}`;
    this.lastActionAt = Date.now();
    await this.bus.send(
      createEnvelope({
        sender: this.id,
        receiver: envelope.sender,
        performative: 'VOTE',
        traceId: envelope.traceId,
        inReplyTo: envelope.msgId,
        content: {
          proposalId: proposal.id,
          approve: evaluation.approve,
          weight: this.weight,
          rationale: evaluation.rationale
        }
      })
    );
  }

  onRequest(envelope) {
    if (envelope.content?.kind !== 'plan.review') return null;
    const advisories = {
      selector: '建议保留礼盒作为低门槛入口，主推单品控制在两款以内',
      controller: '建议第 3 分钟补价格锚点，12 分钟后再进入主推，避免开场信息过载',
      speaker: '建议把参数讲解压到 90 秒并插入冲泡演示，长段口播会掉停留',
      analyst: '建议把发券放到讲解完成之后，保留 A/B 对照样本'
    };
    this.lastAction = '提交方案评审意见';
    this.lastActionAt = Date.now();
    return this.bus.send(
      createEnvelope({
        sender: this.id,
        receiver: envelope.sender,
        performative: 'INFORM',
        traceId: envelope.traceId,
        inReplyTo: envelope.msgId,
        content: {
          kind: 'plan.advisory',
          advisory: advisories[this.logicalRole] ?? '无补充意见'
        }
      })
    );
  }

  onInform(envelope) {
    if (envelope.content?.kind === 'plan.published') {
      this.lastAction = '接收直播方案';
      this.lastActionAt = Date.now();
    }
    return null;
  }

  setStatus(status) {
    this.status = status;
    this.load = status === 'active' ? 0.12 : 0;
    if (status === 'standby') this.lastAction = '热备待命';
    if (status === 'offline') this.lastAction = '实例已下线';
    this.runtime.emit('agent', this.snapshot());
  }

  snapshot() {
    return {
      id: this.id,
      logicalRole: this.logicalRole,
      name: this.name,
      title: this.title,
      latin: this.latin,
      description: this.description,
      accent: this.accent,
      status: this.status,
      load: round(this.load, 3),
      reliability: this.reliability,
      handled: this.handled,
      received: this.received,
      mailbox: this.mailbox.length,
      capabilities: this.capabilities,
      weight: this.weight,
      cognition: this.cognition,
      tools: this.tools,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      currentTask: this.currentTask,
      replicaOf: this.replicaOf,
      recentEnvelopes: this.recentEnvelopes,
      workingMemory: this.runtime.memory.getWorking(this.id, 4)
    };
  }
}

export class SelectorAgent extends Actor {
  async buildPlan(goal, trace) {
    const tracer = this.runtime.tracer;
    const registry = this.runtime.registry;
    this.lastAction = '执行 Plan-Execute：生成直播方案';
    this.lastActionAt = Date.now();
    this.runtime.emit('agent', this.snapshot());

    const memory = await tracer.track(trace, 'memory.recall', this.id, () =>
      registry.call('memory.recall', { query: goal, limit: 3 }, { traceId: trace.id })
    );
    const ranked = await tracer.track(trace, 'catalog.rank', this.id, () =>
      registry.call('catalog.rank', { limit: 4 }, { traceId: trace.id })
    );
    const products = ranked.result.products;
    const hero = products[0];
    const forecast = await tracer.track(trace, 'demand.forecast', this.id, () =>
      registry.call('demand.forecast', { productId: hero.id }, { traceId: trace.id })
    );
    const schedule = await tracer.track(trace, 'schedule.optimize', this.id, () =>
      registry.call(
        'schedule.optimize',
        { durationMin: this.runtime.config.session.durationMin, targetAov: 260 },
        { traceId: trace.id }
      )
    );
    const offer = await tracer.track(trace, 'offer.simulate', this.id, () =>
      registry.call('offer.simulate', { targetGmv: this.runtime.config.session.targetGmv, aov: 260 }, { traceId: trace.id })
    );
    const scripts = [];
    for (const product of products.slice(0, 3)) {
      const segment = schedule.result.segments.find((s) => s.products.includes(product.id)) ?? schedule.result.segments[1];
      const script = await tracer.track(trace, `script.compose:${product.id}`, this.id, () =>
        registry.call(
          'script.compose',
          {
            intent: 'plan',
            productId: product.id,
            style: segment.style,
            stage: segment.context,
            reason: '直播前方案话术初稿'
          },
          { traceId: trace.id }
        )
      );
      scripts.push({
        productId: product.id,
        productName: product.name,
        segment: segment.label,
        style: script.result.style,
        text: script.result.finalText,
        guardrail: script.result.guardrail
      });
    }
    const narrative = this.runtime.llm.plan(goal, products, memory.result.hits);
    const plan = {
      id: uid('PLAN'),
      sessionId: this.runtime.session.id,
      title: this.runtime.config.session.title,
      goal,
      version: 'v1.0',
      createdAt: Date.now(),
      products,
      forecast: forecast.result,
      segments: schedule.result.segments,
      offers: offer.result,
      scripts,
      narrative,
      memoryHits: memory.result.hits,
      toolTrace: trace.spans.map((s) => ({ name: s.name, agent: s.agent, durationMs: s.durationMs })),
      status: 'draft'
    };
    this.runtime.memory.pushWorking(this.id, { kind: 'plan', planId: plan.id, summary: narrative.headline });
    this.lastAction = `方案 v1.0 已生成 · ${products.length} 个商品`;
    this.lastActionAt = Date.now();
    this.runtime.emit('agent', this.snapshot());
    return plan;
  }

  async revisePlan(plan, advisories) {
    const revised = {
      ...plan,
      version: 'v1.1',
      advisories,
      narrative: {
        ...plan.narrative,
        rationale: `${plan.narrative.rationale} 三方评审补充：${advisories.length} 条节奏建议已并入。`
      },
      status: 'ready'
    };
    if (revised.segments[0]) {
      revised.segments[0].goal = '承接自然流量，第 3 分钟给出价格锚点';
    }
    const demoScript = revised.scripts[0];
    if (demoScript) {
      demoScript.text = `${demoScript.text} 接下来我会现场冲一泡，先看汤色，再讲参数。`;
      demoScript.revisedBy = '三方评审';
    }
    this.lastAction = `方案 ${revised.version} 已定稿 · 合并 ${advisories.length} 条评审意见`;
    this.lastActionAt = Date.now();
    this.runtime.emit('agent', this.snapshot());
    return revised;
  }
}

export class ControllerAgent extends Actor {
  async observe(text, meta = {}, trace = null) {
    const registry = this.runtime.registry;
    const tracer = this.runtime.tracer;
    const run = (name, fn) =>
      trace ? tracer.track(trace, name, this.id, fn) : fn();
    const classificationResult = await run('danmaku.classify', () =>
      registry.call('danmaku.classify', { text }, { traceId: meta.traceId, silent: true })
    );
    const classification = classificationResult.result;
    let extra = null;
    if (classification.risk === 'high') {
      extra = await run('sentiment.analyze', () =>
        registry.call('sentiment.analyze', { text }, { traceId: meta.traceId, silent: true })
      );
    }
    if (classification.intent === 'product_question' && classification.productId) {
      await run('inventory.check', () =>
        registry.call(
          'inventory.check',
          { productId: classification.productId },
          { traceId: meta.traceId, silent: true }
        )
      );
    }
    if (trace) {
      tracer.span(trace, 'decision.route', this.id, {
        intent: classification.intent,
        risk: classification.risk
      }).end('ok');
    }

    const actionMap = {
      authenticity_doubt: {
        action: 'pause_push_and_reply',
        label: '暂停逼单并启动信任修复',
        risk: 'high',
        requiresConsensus: true
      },
      negative_feedback: {
        action: 'acknowledge_and_reply',
        label: '承接负面反馈并降速',
        risk: 'high',
        requiresConsensus: true
      },
      compliance_probe: {
        action: 'compliant_reply',
        label: '触发合规改写后回应',
        risk: 'high',
        requiresConsensus: false
      },
      price_objection: {
        action: 'objection_reply',
        label: '化解价格异议',
        risk: 'medium',
        requiresConsensus: false
      },
      purchase_intent: {
        action: 'guide_cart',
        label: '承接购买意图并指路',
        risk: 'low',
        requiresConsensus: false
      },
      product_question: {
        action: 'answer_product',
        label: '回答商品问题',
        risk: 'low',
        requiresConsensus: false
      },
      churn_signal: {
        action: 'reengage',
        label: '挽回流失信号',
        risk: 'medium',
        requiresConsensus: false
      },
      low_value: {
        action: 'ignore_low_value',
        label: '低价值弹幕降级',
        risk: 'low',
        requiresConsensus: false
      }
    };
    const decision = actionMap[classification.intent] ?? {
      action: 'soft_engage',
      label: '轻量互动承接',
      risk: 'low',
      requiresConsensus: false
    };

    const thought = {
      observation: text,
      intent: classification.intent,
      sentiment: classification.sentiment,
      reasoning: `${classification.reasons.join('；')}。情绪 ${classification.sentiment.toFixed(
        2
      )}，选择「${decision.label}」。`,
      reActSteps: [
        { step: 'thought', value: '先判定意图与风险，再决定是否调用工具' },
        { step: 'action', value: '调用 danmaku.classify / sentiment.analyze' },
        { step: 'observation', value: `意图 ${classification.intent} · 情绪 ${classification.sentiment}` },
        { step: 'final', value: decision.label }
      ]
    };

    this.runtime.memory.pushWorking(this.id, {
      kind: 'danmaku',
      text: text.slice(0, 60),
      intent: classification.intent,
      action: decision.action
    });
    this.lastAction = `${decision.label} · ${classification.intent}`;
    this.lastActionAt = Date.now();
    this.runtime.emit('agent', this.snapshot());

    return {
      classification,
      extra: extra?.result ?? null,
      thought,
      decision,
      meta
    };
  }
}

export class SpeakerAgent extends Actor {
  async respond({ classification, intent, style, stage, traceId, reason, trace = null }) {
    const registry = this.runtime.registry;
    const tracer = this.runtime.tracer;
    const run = (name, fn) => (trace ? tracer.track(trace, name, this.id, fn) : fn());
    const productId = classification?.productId ?? this.runtime.session.plan?.products?.[0]?.id ?? 'P-01';
    const script = await run('script.compose', () =>
      registry.call(
        'script.compose',
        {
          intent: intent ?? classification?.intent ?? 'normal',
          productId,
          style,
          stage,
          reason: reason ?? classification?.reasons?.join('；')
        },
        { traceId, silent: true }
      )
    );
    const digital = await run('digital_human.direct', () =>
      registry.call(
        'digital_human.direct',
        { script: script.result.finalText, emotion: script.result.emotion },
        { traceId, silent: true }
      )
    );
    this.runtime.memory.pushWorking(this.id, {
      kind: 'script',
      style: script.result.style,
      productId,
      summary: script.result.finalText.slice(0, 50)
    });
    this.lastAction = `生成「${script.result.style}」话术`;
    this.lastActionAt = Date.now();
    this.runtime.emit('agent', this.snapshot());
    return {
      script: script.result.finalText,
      rawScript: script.result.text,
      style: script.result.style,
      styleSource: script.result.styleSource,
      emotion: script.result.emotion,
      gesture: script.result.gesture,
      guardrail: script.result.guardrail,
      digitalHuman: digital.result,
      productId
    };
  }
}

export class AnalystAgent extends Actor {
  async review(session, trace, metrics) {
    const registry = this.runtime.registry;
    const tracer = this.runtime.tracer;
    const causal = await tracer.track(trace, 'causal.attribution', this.id, () =>
      registry.call(
        'causal.attribution',
        { intervention: this.runtime.coupon?.label ?? '第 52 分钟发放 ¥15 无门槛券' },
        { traceId: trace.id, silent: true }
      )
    );
    const interventions = [];
    if (this.runtime.coupon) {
      interventions.push(`发放${this.runtime.coupon.label}`);
    }
    if (this.runtime.incident) {
      interventions.push(`处置舆情事件 ${this.runtime.incident.id}`);
    }
    if (!interventions.length) interventions.push('自然节奏下的常规讲解');

    const memory = await tracer.track(trace, 'memory.recall', this.id, () =>
      registry.call(
        'memory.recall',
        { query: `${this.runtime.config.session.title} ${interventions.join(' ')}`, limit: 3 },
        { traceId: trace.id, silent: true }
      )
    );
    const reflect = this.runtime.llm.reflect({
      summary: { ...metrics, prepHint: '参数段仍需插入冲泡演示' },
      causal: causal.result,
      sentimentRecovery: this.runtime.incident
        ? {
            triggered: true,
            count: this.runtime.incident.count,
            recoverySec: this.runtime.incident.recoverySec ?? 14
          }
        : { triggered: false },
      latency: { p99: metrics.p99 }
    });

    // 用本场真实响应更新赌博机：购买=1，负面=0，其余不更新。
    let banditUpdates = 0;
    for (const response of session.responses.slice(-40)) {
      let reward = null;
      if (response.intent === 'purchase_intent') reward = 1;
      else if (response.intent === 'authenticity_doubt' || response.intent === 'negative_feedback') reward = 0;
      if (reward == null) continue;
      const updated = this.runtime.bandit.update(response.stage ?? '讲解', response.style, reward);
      if (updated) banditUpdates += 1;
    }

    const funnel = {
      impressions: Math.round(metrics.viewers * 2.4),
      stays: Math.round(metrics.viewers * 0.62),
      interactions: Math.round(metrics.comments * 1.35),
      addCart: Math.round(metrics.orders * 2.35),
      orders: metrics.orders
    };

    const report = {
      id: uid('REV'),
      sessionId: session.id,
      title: this.runtime.config.session.title,
      generatedAt: new Date().toISOString(),
      stage: session.stage,
      summary: `本场共处理 ${metrics.comments} 条弹幕，回应 ${metrics.responses} 次，P99 ${metrics.p99}ms。${
        this.runtime.incident ? '舆情事件已按共识流程处置。' : '未触发高风险事件。'
      }${this.runtime.coupon ? `发券干预估计带来 ${(causal.result.att * 100).toFixed(2)}pp 转化增益。` : ''}`,
      kpis: {
        gmv: metrics.gmv,
        orders: metrics.orders,
        cvr: metrics.cvr,
        interactionRate: metrics.interactionRate,
        aov: metrics.aov,
        peakViewers: metrics.peakViewers,
        prepMinutes: this.runtime.prepMinutes ?? 0,
        reviewMinutes: 1
      },
      causal: {
        ...causal.result,
        dag: this.runtime.causal.dag(interventions[0])
      },
      funnel,
      interventions,
      memoryHits: memory.result.hits,
      lessons: reflect.lessons,
      reflexion: reflect.critique,
      nextActions: this.runtime.buildNextActions(reflect.lessons),
      banditUpdates,
      latency: { p50: metrics.p50, p95: metrics.p95, p99: metrics.p99 },
      simulation: true,
      traceId: trace.id
    };

    this.runtime.memory.addEpisode({
      sessionId: session.id,
      date: new Date().toISOString().slice(0, 10),
      title: this.runtime.config.session.title,
      outcome: `gmv ${metrics.gmv.toLocaleString()} / cvr ${(metrics.cvr * 100).toFixed(1)}% / P99 ${metrics.p99}ms`,
      text: report.summary,
      lessons: reflect.lessons,
      tags: [...new Set(session.responses.map((r) => r.intent))].slice(0, 6),
      metrics: { cvrLift: causal.result.att, p99: metrics.p99 }
    });

    this.runtime.latestReview = report;
    this.lastAction = `完成因果复盘 · ${reflect.lessons.length} 条结论`;
    this.lastActionAt = Date.now();
    this.runtime.emit('agent', this.snapshot());
    return report;
  }
}
