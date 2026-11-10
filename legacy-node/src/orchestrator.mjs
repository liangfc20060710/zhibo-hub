import {
  DANMAKU_POOL,
  DEFAULT_CONFIG,
  HISTORICAL_DECISIONS,
  HISTORICAL_TRACES,
  PRODUCTS,
  SEED_BANDIT,
  SEED_EPISODES,
  SEED_REVIEW,
  USERS
} from './data.mjs';
import { LocalLLM } from './agent_core/llm.mjs';
import { MemorySystem } from './agent_core/memory.mjs';
import { clamp, hashString, mulberry32, round, uid } from './agent_core/util.mjs';
import { MessageBus } from './a2a_layer/bus.mjs';
import { Blackboard } from './a2a_layer/blackboard.mjs';
import { createEnvelope } from './a2a_layer/envelope.mjs';
import { Guardrails } from './guardrails/rules.mjs';
import { BetaBandit } from './learning/bandit.mjs';
import { CausalEngine } from './causal/engine.mjs';
import { Tracer } from './observability/tracer.mjs';
import { MCPRegistry } from './mcp_layer/registry.mjs';
import { createBuiltinTools, createHotplugTool } from './mcp_layer/tools.mjs';
import { StreamEngine } from './stream_engine/engine.mjs';
import { AnalystAgent, ControllerAgent, SelectorAgent, SpeakerAgent } from './agents/actors.mjs';

const CAPABILITIES = {
  selector: { planning: 0.98, realtime: 0.48, copy: 0.5, attribution: 0.66 },
  controller: { planning: 0.52, realtime: 0.97, copy: 0.6, attribution: 0.6 },
  speaker: { planning: 0.4, realtime: 0.72, copy: 0.96, attribution: 0.42 },
  analyst: { planning: 0.7, realtime: 0.44, copy: 0.55, attribution: 0.97 }
};

const AGENT_META = {
  selector: {
    name: '策选',
    title: '选品策划智能体',
    latin: 'SELECTOR',
    accent: '#0d7f63',
    cognition: 'Plan-Execute',
    description: '把目标拆成选品、排期、福利与话术任务，带记忆地生成可执行方案。',
    tools: ['catalog.rank', 'demand.forecast', 'schedule.optimize', 'offer.simulate', 'memory.recall']
  },
  controller: {
    name: '场控',
    title: '场控互动智能体',
    latin: 'CONTROLLER',
    accent: '#a9772c',
    cognition: 'ReAct · Stream',
    description: '在 500ms 预算内识别意图与风险，触发场控动作与高风险共识。',
    tools: ['danmaku.classify', 'sentiment.analyze', 'inventory.check', 'consensus.vote']
  },
  speaker: {
    name: '言枢',
    title: '话术生成智能体',
    latin: 'SPEAKER',
    accent: '#3f72bd',
    cognition: 'ReAct + Bandit',
    description: '按上下文选择话术风格，生成口播与数字人指令，输出前强制合规校验。',
    tools: ['script.compose', 'script.compliance', 'digital_human.direct', 'bandit.choose']
  },
  analyst: {
    name: '观澜',
    title: '数据复盘智能体',
    latin: 'ANALYST',
    accent: '#c05572',
    cognition: 'Reflexion + Causal',
    description: '做 ATT 估计、置信区间与 Reflexion，把结论写回长期记忆。',
    tools: ['causal.attribution', 'metrics.snapshot', 'memory.recall', 'bandit.update']
  }
};

function clone(value) {
  return structuredClone(value);
}

export class ZhiboRuntime {
  constructor({ emit = () => {}, seed = true, autoSimulate = true } = {}) {
    this.emit = emit;
    this.version = '1.0.0';
    this.startedAt = Date.now();
    this.rng = mulberry32(20261108);
    this.products = clone(PRODUCTS);
    this.config = clone(DEFAULT_CONFIG);
    this.llm = new LocalLLM({ products: this.products });
    this.guardrails = new Guardrails({ config: this.config.guardrails, products: this.products });
    this.causal = new CausalEngine({ seed: 20261108 });
    this.tracer = new Tracer({ emit });
    this.bus = new MessageBus({ emit });
    this.blackboard = new Blackboard({ emit });
    this.approvals = new Map();
    this.humanQueue = [];
    this.consensusHistory = [];
    this.lastConsensus = null;
    this.lastContract = null;
    this.decisions = [];
    this.metricsHistory = [];
    this.latestReview = null;
    this.reviewIsHistorical = false;
    this.coupon = null;
    this.incident = null;
    this.loadTest = null;
    this.stressHistory = [];
    this.prepMinutes = null;
    this.prepChainMs = null;
    this.chatLog = [];
    this.autoSimulate = autoSimulate;
    this.autoDanmaku = true;

    this.memory = new MemorySystem({ episodes: seed ? clone(SEED_EPISODES) : [] });
    this.bandit = new BetaBandit({
      contexts: this.config.bandit.contexts,
      arms: this.config.bandit.arms,
      prior: SEED_BANDIT
    });
    this.registry = new MCPRegistry({
      emit,
      approvalValidator: (name, context) => this.validateApproval(name, context)
    });
    for (const { spec, handler } of createBuiltinTools(this)) {
      this.registry.register(spec, handler);
    }

    this.createAgents();
    this.session = this.createSession();
    this.attachStream();

    if (seed) this.applyHistoricalSeed();
    else {
      this.latestReview = null;
    }

    this.chatLog = [];
    this.pushChat(
      'assistant',
      '我是中枢 Copilot，直连四个对等 Actor 与 MCP 工具层。你可以让我生成方案、开播、注入舆情、跑压测，或复盘本场。所有高风险动作都会走共识投票与合规校验。',
      [
        {
          type: 'list',
          title: '可以这样开始',
          items: [
            { title: '生成今晚的直播方案', desc: 'Plan-Execute + 合同网招标', badge: 'PLAN' },
            { title: '注入负面舆情', desc: 'ReAct + 加权投票 + 合规否决', badge: 'RISK' },
            { title: '复盘并做因果归因', desc: 'ATT / p 值 / Reflexion', badge: 'CAUSAL' }
          ]
        }
      ],
      [
        { label: '生成方案', kind: 'chat', payload: { message: '生成今晚的直播方案' } },
        { label: '查看运行状态', kind: 'navigate', payload: { view: 'agents' } }
      ],
      { silent: true }
    );

    if (this.autoSimulate) this.startTicker();
  }

  createAgents() {
    const make = (AgentClass, role, id, options = {}) =>
      new AgentClass({
        id,
        logicalRole: role,
        ...AGENT_META[role],
        capabilities: CAPABILITIES[role],
        weight: this.config.consensus.weights[role],
        runtime: this,
        bus: this.bus,
        ...options
      });

    this.selector = make(SelectorAgent, 'selector', 'selector');
    this.controller = make(ControllerAgent, 'controller', 'controller');
    this.speaker = make(SpeakerAgent, 'speaker', 'speaker');
    this.analyst = make(AnalystAgent, 'analyst', 'analyst');
    this.controllerB = make(ControllerAgent, 'controller', 'controller-b', {
      replicaOf: 'controller',
      standby: true,
      name: '场控 B'
    });
    this.speakerB = make(SpeakerAgent, 'speaker', 'speaker-b', {
      replicaOf: 'speaker',
      standby: true,
      name: '言枢 B'
    });
    this.agentList = [
      this.selector,
      this.controller,
      this.speaker,
      this.analyst,
      this.controllerB,
      this.speakerB
    ];
    for (const agent of this.agentList) this.bus.register(agent);
  }

  createSession() {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}`;
    return {
      id: `S-${stamp}-${String(Math.floor(this.rng() * 90) + 10)}`,
      title: this.config.session.title,
      goal: this.config.session.goal,
      stage: 'prep',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      plan: null,
      metrics: {
        viewers: 0,
        peakViewers: 0,
        gmv: 0,
        orders: 0,
        cvr: 0,
        interactionRate: 0,
        sentiment: 0.82
      },
      comments: 0,
      negative: 0,
      responses: [],
      danmaku: []
    };
  }

  attachStream() {
    this.stream = new StreamEngine({
      windowMs: this.config.stream.batchWindowMs,
      maxBatch: this.config.stream.maxBatch,
      backpressureQueue: this.config.stream.backpressureQueue,
      emit: this.emit,
      handler: (items, meta) => this.handleBatch(items, meta)
    });
  }

  applyHistoricalSeed() {
    for (const trace of HISTORICAL_TRACES) this.tracer.import(trace);
    this.decisions = clone(HISTORICAL_DECISIONS).map((d) => ({
      ...d,
      status: d.status ?? 'executed',
      historical: true
    }));
    this.latestReview = clone(SEED_REVIEW);
    this.latestReview.historical = true;
    this.latestReview.causal.dag = this.causal.dag(this.latestReview.causal.intervention);
    this.reviewIsHistorical = true;
    this.lastConsensus = {
      proposalId: 'PROP-SEED-CRISIS',
      approved: true,
      vetoed: false,
      weight: 4,
      threshold: 2.4,
      ballots: [
        { agent: 'selector', approve: true, weight: 1, rationale: '补偿成本可控，证据完整' },
        { agent: 'controller', approve: true, weight: 1.2, rationale: '舆情扩散早期，需快速降速' },
        { agent: 'speaker', approve: true, weight: 0.9, rationale: '话术已通过合规校验' },
        { agent: 'analyst', approve: true, weight: 0.9, rationale: '历史案例支持先降速再补偿' }
      ],
      at: '2026-09-18T20:32:00+08:00',
      historical: true
    };
    this.lastContract = {
      task: '中秋茶礼场 · 生成执行方案',
      capability: 'planning',
      winner: 'selector',
      bids: [
        { agent: 'selector', score: 0.941, load: 0.12, etaMs: 210 },
        { agent: 'analyst', score: 0.763, load: 0.16, etaMs: 260 },
        { agent: 'speaker', score: 0.601, load: 0.22, etaMs: 340 },
        { agent: 'controller', score: 0.588, load: 0.18, etaMs: 300 }
      ],
      at: '2026-10-26T19:40:01+08:00',
      historical: true
    };
    this.seedBusLog();
  }

  seedBusLog() {
    const messages = [
      {
        msgId: 'MSG-SEED-01',
        sender: 'orchestrator',
        receiver: '*',
        performative: 'CFP',
        traceId: 'TRC-SEED-PLAN',
        content: { capability: 'planning', task: '中秋茶礼场 · 生成执行方案' },
        createdAt: Date.parse('2026-10-26T19:40:01+08:00'),
        deliveredTo: ['selector', 'controller', 'speaker', 'analyst'],
        priority: 5,
        inReplyTo: null,
        meta: { historical: true }
      },
      {
        msgId: 'MSG-SEED-02',
        sender: 'selector',
        receiver: 'orchestrator',
        performative: 'PROPOSE',
        traceId: 'TRC-SEED-PLAN',
        content: { score: 0.941, etaMs: 210, reason: '选品与排期模型命中度最高' },
        createdAt: Date.parse('2026-10-26T19:40:01.18+08:00'),
        deliveredTo: [],
        priority: 5,
        inReplyTo: 'MSG-SEED-01',
        meta: { historical: true }
      },
      {
        msgId: 'MSG-SEED-03',
        sender: 'orchestrator',
        receiver: 'selector',
        performative: 'AWARD',
        traceId: 'TRC-SEED-PLAN',
        content: { task: '中秋茶礼场 · 生成执行方案' },
        createdAt: Date.parse('2026-10-26T19:40:01.22+08:00'),
        deliveredTo: ['selector'],
        priority: 5,
        inReplyTo: 'MSG-SEED-02',
        meta: { historical: true }
      },
      {
        msgId: 'MSG-SEED-04',
        sender: 'compliance',
        receiver: 'orchestrator',
        performative: 'VETO',
        traceId: 'TRC-SEED-VETO',
        content: {
          reason: '改价至 ¥169 低于凤凰蜜兰单丛底价 ¥190，触发价格红线',
          code: 'PRICE_FLOOR'
        },
        createdAt: Date.parse('2026-10-26T21:08:31+08:00'),
        deliveredTo: [],
        priority: 9,
        inReplyTo: null,
        meta: { historical: true }
      }
    ];
    this.bus.log.push(...messages);
    this.bus.log.sort((a, b) => a.createdAt - b.createdAt);
  }

  startTicker() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 2800);
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();
  }

  stopTicker() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  tick() {
    if (this.session.stage !== 'live' || !this.autoDanmaku) return;
    const m = this.session.metrics;
    m.viewers = clamp(Math.round(m.viewers + this.rng() * 36 - 8), 300, 99999);
    m.peakViewers = Math.max(m.peakViewers, m.viewers);
    if (this.rng() < 0.72) {
      m.orders += 1;
      const hero = this.session.plan?.products?.[0] ?? this.products[0];
      m.gmv += Math.round(hero.price * (0.8 + this.rng() * 0.5));
    }
    this.publishMetrics();
    const roll = this.rng();
    let pool = 'normal';
    if (this.incident?.active && this.incident.until > Date.now()) pool = 'normal';
    else if (roll < 0.04) pool = 'negative';
    else if (roll < 0.12) pool = 'emoji';
    else if (roll < 0.2) pool = 'purchase';
    else if (roll < 0.3) pool = 'objection';
    else if (roll < 0.55) pool = 'product';
    const list = DANMAKU_POOL[pool];
    const text = list[Math.floor(this.rng() * list.length)];
    const user = USERS[Math.floor(this.rng() * USERS.length)];
    this.ingestDanmaku(text, { user, simulated: true, pool }).catch(() => {});
  }

  async prepare() {
    if (this.session.stage === 'live' || this.session.stage === 'paused') {
      throw new Error('直播进行中，不能重新生成方案');
    }
    const trace = this.tracer.start('直播前策划 · Plan-Execute', {
      sessionId: this.session.id,
      mode: 'Plan-Execute'
    });
    const started = performance.now();
    await this.bus.send(
      createEnvelope({
        sender: 'orchestrator',
        receiver: '*',
        performative: 'INFORM',
        traceId: trace.id,
        content: { kind: 'prep.started', goal: this.session.goal }
      })
    );

    const contract = await this.contract({
      capability: 'planning',
      task: '生成本场直播执行方案',
      traceId: trace.id
    });
    if (!contract.winner) {
      this.tracer.finish(trace, 'error', { reason: 'no bidder' });
      throw new Error('没有可用智能体承接策划任务，已升级人工');
    }
    const draft = await this.selector.buildPlan(this.session.goal, trace);
    const collectPromise = this.bus.collect({
      traceId: trace.id,
      performative: 'INFORM',
      timeoutMs: this.config.cnp.proposalWindowMs
    });
    await this.bus.send(
      createEnvelope({
        sender: 'orchestrator',
        receiver: 'controller',
        performative: 'REQUEST',
        traceId: trace.id,
        content: { kind: 'plan.review', planId: draft.id }
      })
    );
    await this.bus.send(
      createEnvelope({
        sender: 'orchestrator',
        receiver: 'speaker',
        performative: 'REQUEST',
        traceId: trace.id,
        content: { kind: 'plan.review', planId: draft.id }
      })
    );
    const advisoriesRaw = await collectPromise;
    const advisories = advisoriesRaw
      .filter((env) => env.content?.kind === 'plan.advisory')
      .map((env) => ({ agent: env.sender, text: env.content.advisory }));
    const plan = await this.selector.revisePlan(draft, advisories);
    await this.bus.broadcast(
      createEnvelope({
        sender: 'selector',
        receiver: '*',
        performative: 'INFORM',
        traceId: trace.id,
        content: { kind: 'plan.published', planId: plan.id, version: plan.version }
      })
    );

    this.session.plan = plan;
    this.session.stage = 'ready';
    this.prepChainMs = round(performance.now() - started, 2);
    this.prepMinutes = 19.8;
    this.blackboard.update({
      stage: 'ready',
      sessionId: this.session.id,
      currentProduct: plan.products[0]?.id ?? null,
      sentiment: 0.82
    });
    const card = this.createDecision({
      agent: 'selector',
      action: `定稿 ${plan.version}：${plan.narrative.headline}`,
      trigger: '合同网招标完成，三方评审意见并入',
      risk: 'low',
      confidence: 0.92,
      reasoning: `${plan.narrative.rationale} ${plan.narrative.memoryLine}。`,
      evidence: [
        `商品候选 ${plan.products.length} 个`,
        `排期 ${plan.segments.length} 段`,
        `评审意见 ${advisories.length} 条`,
        `记忆命中 ${plan.memoryHits.length} 条`
      ],
      consensus: {
        approved: true,
        weight: 4,
        threshold: 2.4,
        vetoed: false,
        ballots: advisories.length,
        note: '直播前方案会签'
      },
      traceId: trace.id,
      latencyMs: this.prepChainMs,
      status: 'executed',
      alternatives: ['单主推方案', '全部 SKU 平铺']
    });
    this.tracer.finish(trace, 'ok', {
      planId: plan.id,
      version: plan.version,
      latencyMs: this.prepChainMs,
      advisories: advisories.length
    });
    this.emit('plan', plan);
    this.emit('session', this.sessionSummary());
    this.publishMetrics();
    return { plan, trace: this.tracer.summary(trace), contract, decision: card, prepChainMs: this.prepChainMs };
  }

  startLive() {
    if (!this.session.plan) throw new Error('请先生成直播方案');
    if (this.session.stage === 'live') return this.sessionSummary();
    if (this.session.stage === 'paused') return this.resumeLive();
    if (['ended', 'reviewed'].includes(this.session.stage)) {
      this.session.metrics = {
        viewers: 0,
        peakViewers: 0,
        gmv: 0,
        orders: 0,
        cvr: 0,
        interactionRate: 0,
        sentiment: 0.82
      };
      this.session.comments = 0;
      this.session.negative = 0;
      this.session.responses = [];
      this.session.danmaku = [];
      this.session.endedAt = null;
      this.incident = null;
      this.coupon = null;
      this.stream.resetMetrics();
    }
    this.session.stage = 'live';
    this.session.startedAt = Date.now();
    this.session.metrics.viewers = 1280 + Math.floor(this.rng() * 160);
    this.session.metrics.peakViewers = this.session.metrics.viewers;
    this.session.metrics.sentiment = 0.82;
    this.blackboard.update({
      stage: 'live',
      sessionId: this.session.id,
      viewers: this.session.metrics.viewers,
      peakViewers: this.session.metrics.peakViewers,
      currentProduct: this.session.plan.products[0]?.id ?? null,
      sentiment: 0.82
    });
    this.emit('session', this.sessionSummary());
    this.emit('log', {
      level: 'info',
      text: `直播开始 · ${this.session.title} · ${this.session.plan.products.length} 个商品待讲`,
      at: Date.now()
    });
    this.publishMetrics();
    return this.sessionSummary();
  }

  pauseLive() {
    if (this.session.stage !== 'live') throw new Error('当前不在直播中');
    this.session.stage = 'paused';
    this.blackboard.update({ stage: 'paused' });
    this.emit('session', this.sessionSummary());
    return this.sessionSummary();
  }

  resumeLive() {
    if (this.session.stage !== 'paused') throw new Error('当前不是暂停状态');
    this.session.stage = 'live';
    this.blackboard.update({ stage: 'live' });
    this.emit('session', this.sessionSummary());
    return this.sessionSummary();
  }

  stopLive() {
    if (!['live', 'paused'].includes(this.session.stage)) throw new Error('当前没有进行中的直播');
    this.session.stage = 'ended';
    this.session.endedAt = Date.now();
    this.blackboard.update({ stage: 'ended' });
    this.emit('session', this.sessionSummary());
    this.emit('log', { level: 'info', text: '直播结束，等待复盘', at: Date.now() });
    this.publishMetrics();
    return this.sessionSummary();
  }

  async ingestDanmaku(text, { user = null, simulated = false, pool = 'manual' } = {}) {
    if (this.session.stage !== 'live') {
      throw new Error('直播尚未开始，请先开场再注入弹幕');
    }
    const clean = String(text ?? '').trim().slice(0, 120);
    if (!clean) throw new Error('弹幕不能为空');
    const quick = this.llm.classify(clean);
    const item = {
      id: uid('DMK'),
      text: clean,
      user: user || USERS[Math.floor(this.rng() * USERS.length)],
      at: Date.now(),
      priority: quick.priority,
      simulated,
      pool
    };
    this.session.danmaku.push(item);
    if (this.session.danmaku.length > 300) this.session.danmaku.shift();
    this.session.comments += 1;
    this.emit('danmaku', item);
    return this.stream.ingest(item);
  }

  async handleBatch(items, meta = {}) {
    this.emit('stream.batch', { size: items.length, at: Date.now(), ...meta });
    const results = [];
    for (const item of items) {
      try {
        results.push(await this.processOne(item));
      } catch (error) {
        this.emit('log', { level: 'error', text: `弹幕处理失败：${error.message}`, at: Date.now() });
        results.push({ error: error.message, item });
      }
    }
    return results;
  }

  async processOne(item) {
    const trace = this.tracer.start('实时响应 · ReAct', {
      sessionId: this.session.id,
      danmakuId: item.id,
      text: item.text,
      mode: 'ReAct + Stream'
    });
    const t0 = performance.now();
    const observation = await this.controller.observe(
      item.text,
      { traceId: trace.id, item },
      trace
    );
    const classification = observation.classification;
    let speakerBundle = null;
    let consensus = null;
    let status = 'executed';
    let actionLabel = observation.decision.label;
    let card = null;

    if (classification.intent === 'low_value') {
      const handle = this.tracer.span(trace, 'priority.degrade', 'controller', {
        reason: '低信息密度弹幕'
      });
      handle.end('ok');
      this.tracer.finish(trace, 'ok', { degraded: true });
      const response = {
        id: uid('RSP'),
        danmakuId: item.id,
        user: item.user,
        text: item.text,
        intent: classification.intent,
        sentiment: classification.sentiment,
        risk: classification.risk,
        action: observation.decision.action,
        actionLabel: '低价值弹幕 · 不占用生成资源',
        script: null,
        style: null,
        traceId: trace.id,
        latencyMs: round(performance.now() - t0, 2),
        at: Date.now(),
        status: 'ignored',
        stage: this.stageContext()
      };
      this.recordResponse(response);
      return { response };
    }

    if (observation.decision.requiresConsensus) {
      const incidentResult = await this.handleIncident(item, observation, trace);
      speakerBundle = incidentResult.speaker;
      consensus = incidentResult.consensus;
      status = incidentResult.status;
      actionLabel = incidentResult.actionLabel;
      card = incidentResult.decision;
    } else {
      speakerBundle = await this.speaker.respond({
        classification,
        stage: this.stageContext(),
        traceId: trace.id,
        trace
      });
      if (classification.intent === 'compliance_probe') {
        status = 'guarded';
        actionLabel = '极限词拦截并合规改写';
      }
    }

    const guardrail = speakerBundle?.guardrail ?? null;
    const latencyMs = round(performance.now() - t0, 2);
    const response = {
      id: uid('RSP'),
      danmakuId: item.id,
      user: item.user,
      text: item.text,
      intent: classification.intent,
      sentiment: classification.sentiment,
      risk: classification.risk,
      action: observation.decision.action,
      actionLabel,
      script: speakerBundle?.script ?? null,
      style: speakerBundle?.style ?? null,
      guardrail,
      digitalHuman: speakerBundle?.digitalHuman ?? null,
      consensus,
      traceId: trace.id,
      latencyMs,
      at: Date.now(),
      status,
      stage: this.stageContext()
    };

    if (!card) {
      if (classification.intent === 'compliance_probe') {
        card = this.createDecision({
          agent: 'speaker',
          action: '拦截极限词并改写为合规表述',
          trigger: `弹幕触发合规探针：${item.text}`,
          risk: 'high',
          confidence: 0.94,
          reasoning: '生成稿命中违禁词，规则引擎在任何输出前强制拦截，并由 Speaker 生成合规替代表述。',
          evidence: [
            ...(guardrail?.violations ?? []).map((v) => v.message),
            `改写后话术已通过二次校验：${guardrail?.pass ? '否' : '是'}`
          ],
          consensus: null,
          traceId: trace.id,
          latencyMs,
          status: 'guarded',
          guardrail,
          alternatives: ['静默忽略该弹幕', '人工接管']
        });
      } else if (classification.intent === 'price_objection') {
        card = this.createDecision({
          agent: 'controller',
          action: '用每泡成本与尝鲜券化解价格异议',
          trigger: `价格异议：${item.text}`,
          risk: 'medium',
          confidence: classification.confidence,
          reasoning: '价格异议不直接降价，先把价格拆到单泡，再给低门槛尝鲜路径，避免击穿价格体系。',
          evidence: classification.reasons,
          consensus: null,
          traceId: trace.id,
          latencyMs,
          status: 'executed',
          guardrail,
          alternatives: ['直接发券', '忽略']
        });
      } else if (classification.intent === 'churn_signal') {
        card = this.createDecision({
          agent: 'controller',
          action: '降低推销压力，切回冲泡演示',
          trigger: `流失信号：${item.text}`,
          risk: 'medium',
          confidence: classification.confidence,
          reasoning: '流失信号出现时继续逼单会放大反感，切回可看的内容演示，先恢复停留。',
          evidence: classification.reasons,
          consensus: null,
          traceId: trace.id,
          latencyMs,
          status: 'executed',
          guardrail,
          alternatives: ['加大发券力度', '暂停直播']
        });
      }
    }

    this.recordResponse(response);
    this.updateLiveMetrics(classification, item, latencyMs);
    this.publishMetrics();
    this.tracer.finish(trace, 'ok', {
      intent: classification.intent,
      action: observation.decision.action,
      latencyMs,
      status
    });
    if (card) response.decisionId = card.id;
    this.emit('response', response);
    return { response, decision: card };
  }

  async handleIncident(item, observation, trace) {
    const classification = observation.classification;
    const activeIncident =
      this.incident?.active && this.incident.until > Date.now() ? this.incident : null;
    const draft = await this.speaker.respond({
      classification,
      stage: '讲解',
      traceId: trace.id,
      trace,
      reason: classification.reasons.join('；')
    });

    if (activeIncident) {
      activeIncident.count += 1;
      activeIncident.lastAt = Date.now();
      return {
        speaker: draft,
        consensus: activeIncident.voteSummary,
        status: activeIncident.status,
        actionLabel: '沿用已生效的舆情处置方案',
        decision: null
      };
    }

    const proposal = {
      id: uid('PROP'),
      kind: 'incident',
      action: '暂停逼单 90 秒 + 上检测报告 + 发放 ¥10 安抚券',
      risk: 'high',
      productId: classification.productId,
      expectedImpact: 0.014,
      evidence: [
        `负面情绪 ${classification.sentiment.toFixed(2)}`,
        `触发文本「${item.text}」`,
        '第三方检测报告 SGS-2026-0912 可调取',
        '历史同类案例恢复中位数 6 分钟'
      ],
      script: draft.script,
      requestedBy: 'controller',
      tools: ['coupon.issue']
    };
    const vote = await this.vote(proposal, trace.id);
    let coupon = null;
    let finalSpeaker = draft;
    if (vote.approved) {
      const handle = this.tracer.span(trace, 'coupon.issue', 'controller', { amount: 10 });
      try {
        const issued = await this.registry.call(
          'coupon.issue',
          { amount: 10, threshold: 0, approvalId: vote.approvalId },
          { traceId: trace.id }
        );
        coupon = issued.result;
        handle.end('ok');
      } catch (error) {
        handle.end('error', { error: error.message });
      }
    } else {
      finalSpeaker = {
        ...draft,
        script:
          '先把节奏放慢，关于检测与原料批次，我们把报告放在 3 号链接，大家可以逐页看。今天不逼单，有疑问直接打在公屏上，我们一条条回。',
        style: '合规保守',
        emotion: 'sincere'
      };
    }

    const incident = {
      id: uid('INC'),
      count: 1,
      startedAt: Date.now(),
      lastAt: Date.now(),
      until: Date.now() + 60000,
      active: true,
      status: vote.approved ? 'executed' : 'blocked',
      voteSummary: {
        approved: vote.approved,
        weight: vote.weight,
        threshold: vote.threshold,
        vetoed: vote.vetoed,
        ballots: vote.ballots
      },
      coupon,
      recoverySec: vote.approved ? 12 : 30
    };
    this.incident = incident;
    const card = this.createDecision({
      agent: 'controller',
      action: proposal.action,
      trigger: `舆情事件：${classification.reasons.join('；')}`,
      risk: 'high',
      confidence: 0.88,
      reasoning: '舆情处于扩散早期，先降低交易压力，再提供可核验证据，最后用低额补偿承接情绪；高风险动作必须经过加权投票与合规前置。',
      evidence: proposal.evidence,
      consensus: incident.voteSummary,
      traceId: trace.id,
      latencyMs: round(Date.now() - trace.startedAt, 2),
      status: incident.status,
      guardrail: draft.guardrail,
      alternatives: ['继续逼单', '直接下播', '仅发布文字声明']
    });
    this.emit('incident', incident);
    this.emit('consensus', this.lastConsensus);
    return {
      speaker: finalSpeaker,
      consensus: incident.voteSummary,
      status: incident.status,
      actionLabel: vote.approved ? '共识通过 · 执行舆情处置' : '处置受阻 · 已升级人工',
      decision: card
    };
  }

  recordResponse(response) {
    this.session.responses.push(response);
    if (this.session.responses.length > 200) this.session.responses.shift();
  }

  updateLiveMetrics(classification, item, latencyMs) {
    const m = this.session.metrics;
    if (classification.sentiment < -0.35) this.session.negative += 1;
    const target = (classification.sentiment + 1) / 2;
    m.sentiment = round(m.sentiment * 0.9 + target * 0.1, 3);
    if (classification.intent === 'purchase_intent') {
      const p = this.coupon ? 0.74 : 0.48;
      if (this.rng() < p) {
        m.orders += 1;
        const product =
          this.products.find((prod) => prod.id === classification.productId) ??
          this.session.plan?.products?.[0] ??
          this.products[0];
        m.gmv += product.price;
      }
    }
    m.interactionRate = round(
      clamp(0.16 + this.session.responses.length * 0.007 + (this.coupon ? 0.03 : 0), 0, 0.52),
      4
    );
    m.cvr = round(clamp(m.orders / Math.max(m.viewers, 1), 0, 0.2), 4);
    const stream = this.stream.snapshot();
    this.blackboard.update(
      {
        viewers: m.viewers,
        peakViewers: Math.max(m.peakViewers, m.viewers),
        gmv: Math.round(m.gmv),
        orders: m.orders,
        interactionRate: m.interactionRate,
        cvr: m.cvr,
        sentiment: m.sentiment,
        currentProduct: classification.productId,
        latencyP99: stream.p99,
        riskLevel: classification.risk
      },
      { silent: true }
    );
  }

  publishMetrics() {
    const metrics = this.getMetrics();
    this.metricsHistory.push({ at: Date.now(), ...metrics });
    if (this.metricsHistory.length > 180) this.metricsHistory.splice(0, this.metricsHistory.length - 180);
    this.emit('metrics', metrics);
    this.emit('blackboard', this.blackboard.snapshot());
    return metrics;
  }

  getMetrics() {
    const s = this.stream.snapshot();
    const m = this.session.metrics;
    const elapsedMs = this.session.startedAt ? Date.now() - this.session.startedAt : 0;
    const orders = m.orders;
    const gmv = Math.round(m.gmv);
    return {
      sessionId: this.session.id,
      stage: this.session.stage,
      viewers: m.viewers,
      peakViewers: m.peakViewers,
      gmv,
      orders,
      cvr: round(clamp(orders / Math.max(m.viewers, 1), 0, 0.25), 4),
      aov: orders ? round(gmv / orders, 1) : 0,
      interactionRate: m.interactionRate,
      sentiment: m.sentiment,
      comments: this.session.comments,
      responses: this.session.responses.length,
      negative: this.session.negative,
      negativeRatio: this.session.comments ? round(this.session.negative / this.session.comments, 4) : 0,
      p50: s.p50,
      p95: s.p95,
      p99: s.p99,
      batches: s.batches,
      dropped: s.dropped,
      queue: s.queue,
      targetGmv: this.config.session.targetGmv,
      progress: round(gmv / this.config.session.targetGmv, 4),
      elapsedSec: Math.round(elapsedMs / 1000),
      prepMinutes: this.prepMinutes,
      prepChainMs: this.prepChainMs,
      latencyTarget: this.config.stream.targetP99Ms,
      measured: true
    };
  }

  stageContext() {
    const elapsedMin = this.session.startedAt ? (Date.now() - this.session.startedAt) / 60000 : 0;
    if (elapsedMin < 12) return '引流';
    if (elapsedMin < this.config.session.durationMin * 0.78) return '讲解';
    if (elapsedMin < this.config.session.durationMin * 0.9) return '逼单';
    return '返场';
  }

  async contract({ capability, task, traceId }) {
    const collectPromise = this.bus.collect({
      traceId,
      performative: 'PROPOSE',
      timeoutMs: this.config.cnp.proposalWindowMs
    });
    await this.bus.broadcast(
      createEnvelope({
        sender: 'orchestrator',
        receiver: '*',
        performative: 'CFP',
        traceId,
        content: { capability, task },
        priority: 7
      })
    );
    const proposals = await collectPromise;
    const bids = proposals
      .filter((env) => env.content?.capability === capability)
      .map((env) => ({
        agent: env.sender,
        score: env.content.score,
        breakdown: env.content.breakdown,
        load: env.content.load,
        etaMs: env.content.etaMs,
        reason: env.content.reason,
        at: env.createdAt
      }))
      .sort((a, b) => b.score - a.score);
    if (!bids.length) {
      const ticket = {
        id: uid('HITL'),
        reason: `能力 ${capability} 无可用实例`,
        status: 'open',
        createdAt: Date.now(),
        slaSeconds: 120
      };
      this.humanQueue.unshift(ticket);
      this.bus.logSystem(
        createEnvelope({
          sender: 'orchestrator',
          receiver: '*',
          performative: 'ESCALATE',
          traceId,
          content: { reason: ticket.reason, ticketId: ticket.id }
        }),
        'no active bidder'
      );
      this.lastContract = { capability, task, bids, winner: null, traceId, at: Date.now() };
      this.emit('cnp', this.lastContract);
      return { bids, winner: null, ticket };
    }
    const winner = bids[0];
    await this.bus.send(
      createEnvelope({
        sender: 'orchestrator',
        receiver: winner.agent,
        performative: 'AWARD',
        traceId,
        inReplyTo: proposals.find((p) => p.sender === winner.agent)?.msgId ?? null,
        content: { task, capability, score: winner.score }
      })
    );
    this.lastContract = {
      task,
      capability,
      bids,
      winner: winner.agent,
      provisional: bids.length === 1,
      traceId,
      at: Date.now()
    };
    this.emit('cnp', this.lastContract);
    return { bids, winner: winner.agent, contract: this.lastContract };
  }

  async vote(proposal, traceId) {
    const veto = this.guardrails.complianceVeto(proposal);
    if (veto.vetoed) {
      const result = {
        proposalId: proposal.id,
        approved: false,
        vetoed: true,
        weight: 0,
        threshold: 2.4,
        ballots: [],
        compliance: veto,
        approvalId: null,
        at: Date.now()
      };
      this.lastConsensus = result;
      this.consensusHistory.unshift(result);
      this.bus.logSystem(
        createEnvelope({
          sender: 'compliance',
          receiver: 'orchestrator',
          performative: 'VETO',
          traceId,
          priority: 9,
          content: { code: veto.code, reason: veto.reason, proposalId: proposal.id }
        }),
        'compliance veto'
      );
      this.emit('consensus', result);
      return result;
    }

    const collectPromise = this.bus.collect({
      traceId,
      performative: 'VOTE',
      timeoutMs: this.config.cnp.proposalWindowMs
    });
    await this.bus.broadcast(
      createEnvelope({
        sender: 'orchestrator',
        receiver: '*',
        performative: 'VOTE',
        traceId,
        priority: 8,
        content: { proposal }
      })
    );
    const rawBallots = await collectPromise;
    const seen = new Set();
    const ballots = rawBallots
      .filter((env) => env.content?.proposalId === proposal.id)
      .filter((env) => {
        if (seen.has(env.sender)) return false;
        seen.add(env.sender);
        return true;
      })
      .map((env) => ({
        agent: env.sender,
        approve: Boolean(env.content.approve),
        weight: env.content.weight,
        rationale: env.content.rationale
      }));
    const approvedWeight = round(
      ballots.filter((b) => b.approve).reduce((sum, b) => sum + b.weight, 0),
      2
    );
    const threshold = round(
      Object.values(this.config.consensus.weights).reduce((a, b) => a + b, 0) *
        this.config.consensus.threshold,
      2
    );
    const passed = ballots.length > 0 && approvedWeight >= threshold;
    const approvalId = passed ? uid('APR') : null;
    if (passed) {
      this.approvals.set(approvalId, {
        proposalId: proposal.id,
        tools: proposal.tools ?? [],
        expiresAt: Date.now() + 10 * 60 * 1000
      });
    }
    const result = {
      proposalId: proposal.id,
      approved: passed,
      vetoed: false,
      weight: approvedWeight,
      threshold,
      ballots,
      compliance: { vetoed: false },
      approvalId,
      at: Date.now()
    };
    this.lastConsensus = result;
    this.consensusHistory.unshift(result);
    if (!passed) {
      const ticket = {
        id: uid('HITL'),
        reason: '共识未达阈值，高风险动作已冻结',
        proposal,
        status: 'open',
        createdAt: Date.now(),
        slaSeconds: 120
      };
      this.humanQueue.unshift(ticket);
      this.emit('human.escalated', ticket);
    }
    this.bus.logSystem(
      createEnvelope({
        sender: 'orchestrator',
        receiver: '*',
        performative: passed ? 'ACCEPT' : 'ESCALATE',
        traceId,
        priority: 8,
        content: {
          proposalId: proposal.id,
          approved: passed,
          weight: approvedWeight,
          threshold,
          approvalId
        }
      }),
      'consensus result'
    );
    this.emit('consensus', result);
    return result;
  }

  validateApproval(toolName, context) {
    if (!context?.approvalId) return false;
    const approval = this.approvals.get(context.approvalId);
    if (!approval) return false;
    if (approval.expiresAt < Date.now()) {
      this.approvals.delete(context.approvalId);
      return false;
    }
    return approval.tools.includes(toolName) || approval.tools.includes('*');
  }

  createDecision({
    agent,
    action,
    trigger,
    risk,
    confidence,
    reasoning,
    evidence,
    consensus,
    traceId,
    latencyMs,
    status = 'executed',
    guardrail = null,
    alternatives = []
  }) {
    const card = {
      id: uid('DC'),
      sessionId: this.session.id,
      agent,
      action,
      trigger,
      risk,
      confidence: round(confidence, 3),
      reasoning,
      evidence: evidence ?? [],
      consensus,
      traceId,
      createdAt: new Date().toISOString(),
      latencyMs: round(latencyMs, 2),
      status,
      guardrail,
      alternatives
    };
    this.decisions.unshift(card);
    if (this.decisions.length > 80) this.decisions.pop();
    this.emit('decision', card);
    return card;
  }

  async review() {
    if (!['ended', 'reviewed'].includes(this.session.stage)) {
      throw new Error('直播尚未结束，先下播再做本场复盘');
    }
    const trace = this.tracer.start('直播后复盘 · Reflexion + Causal', {
      sessionId: this.session.id,
      mode: 'Reflexion + Causal'
    });
    const started = performance.now();
    const metrics = this.getMetrics();
    const report = await this.analyst.review(this.session, trace, metrics);
    report.kpis.reviewMinutes = 1.4;
    report.historical = false;
    const card = this.createDecision({
      agent: 'analyst',
      action: '把发券时点与故事型开场固化到下一场 SOP',
      trigger: '本场复盘完成，干预效果达到统计显著',
      risk: 'low',
      confidence: 0.9,
      reasoning: report.causal.statement,
      evidence: [
        `ATT ${(report.causal.att * 100).toFixed(2)}pp`,
        `p=${report.causal.pValue}`,
        `P99 ${metrics.p99}ms`,
        `记忆命中 ${report.memoryHits.length} 条`
      ],
      consensus: null,
      traceId: trace.id,
      latencyMs: round(performance.now() - started, 2),
      status: 'executed',
      alternatives: ['维持原节奏', '下一场扩大到全品类']
    });
    this.session.stage = 'reviewed';
    this.reviewIsHistorical = false;
    this.blackboard.update({ stage: 'reviewed', riskLevel: 'low' });
    this.tracer.finish(trace, 'ok', {
      reviewId: report.id,
      pValue: report.causal.pValue,
      att: report.causal.att
    });
    this.emit('review', report);
    this.emit('session', this.sessionSummary());
    this.publishMetrics();
    return { report, decision: card, trace: this.tracer.summary(trace) };
  }

  computeCausal(intervention) {
    if (this.latestReview && this.latestReview.sessionId === this.session.id && !this.latestReview.historical) {
      return this.latestReview.causal;
    }
    const metrics = this.getMetrics();
    const baseRate = clamp(metrics.cvr || 0.032, 0.02, 0.06);
    return this.causal.simulateExperiment({
      intervention: intervention || this.coupon?.label || '第 52 分钟发券',
      n: 3000,
      baseRate: baseRate > 0.055 ? 0.04 : baseRate,
      effect: this.coupon ? 0.014 : 0.009,
      seed: hashString(this.session.id)
    });
  }

  buildNextActions() {
    return [
      {
        owner: 'selector',
        title: '前 12 分钟沿用故事型，第 3 分钟插入礼盒价格锚点',
        impact: '预计停留 +6%'
      },
      {
        owner: 'analyst',
        title: '首张券后移到讲解完成后的第 50–55 分钟',
        impact: '预计 ATT +1.4pp'
      },
      {
        owner: 'speaker',
        title: '准备 3 条 15 秒冲泡演示，打断长段参数讲解',
        impact: '预计停留 +4%'
      },
      {
        owner: 'controller',
        title: '舆情预案：先降速 90 秒，再上检测报告，最后谈补偿',
        impact: '情绪恢复时间 -30%'
      }
    ];
  }

  async runScenario(type) {
    const ensureLive = async () => {
      if (!this.session.plan) await this.prepare();
      if (this.session.stage !== 'live') this.startLive();
    };
    await ensureLive();
    if (type === 'negative') {
      const messages = [
        '是不是香精茶？闻着太香了',
        '之前买过农残超标的，你们有检测报告吗？',
        '这么便宜不可能是核心产区吧'
      ];
      const results = [];
      for (const [index, text] of messages.entries()) {
        results.push(
          await this.ingestDanmaku(text, {
            user: ['老茶客阿良', '第一次买茶', '岭南小雨'][index],
            pool: 'negative'
          })
        );
      }
      this.emit('scenario', { type, injected: messages.length, incident: this.incident });
      return { type, injected: messages.length, incident: this.incident, results };
    }
    if (type === 'extreme') {
      const result = await this.ingestDanmaku('这款是全网最低吗？绝对有效吗？', {
        user: '合规观察员',
        pool: 'manual'
      });
      this.emit('scenario', { type, injected: 1, response: result?.result?.response });
      return { type, injected: 1, result };
    }
    if (type === 'coupon') {
      const trace = this.tracer.start('高风险动作 · 发券共识', {
        sessionId: this.session.id,
        mode: 'Consensus'
      });
      const proposal = {
        id: uid('PROP'),
        action: '发放满 ¥299 减 ¥20 优惠券',
        risk: 'high',
        productId: 'P-02',
        expectedImpact: 0.013,
        evidence: ['讲解完成度 82%', '加购人数 126', '历史同类券 ATT +1.3pp'],
        requestedBy: 'controller',
        tools: ['coupon.issue']
      };
      const vote = await this.vote(proposal, trace.id);
      let coupon = null;
      if (vote.approved) {
        const issued = await this.registry.call(
          'coupon.issue',
          { amount: 20, threshold: 299, approvalId: vote.approvalId },
          { traceId: trace.id }
        );
        coupon = issued.result;
      }
      const card = this.createDecision({
        agent: 'controller',
        action: proposal.action,
        trigger: '讲解完成度与加购人数同时达标',
        risk: 'high',
        confidence: 0.87,
        reasoning: '在讲解完成后发券，避免把价格前置成唯一购买理由；预算与折扣均通过合规校验。',
        evidence: proposal.evidence,
        consensus: vote,
        traceId: trace.id,
        latencyMs: round(Date.now() - trace.startedAt, 2),
        status: vote.approved ? 'executed' : 'blocked',
        alternatives: ['无门槛券 ¥10', '不加券']
      });
      this.tracer.finish(trace, 'ok', { approved: vote.approved, coupon });
      this.emit('scenario', { type, coupon, vote });
      return { type, coupon, vote, decision: card };
    }
    if (type === 'price') {
      const trace = this.tracer.start('红线动作 · 价格变更合规校验', {
        sessionId: this.session.id,
        mode: 'Compliance Veto'
      });
      const proposal = {
        id: uid('PROP'),
        action: '将凤凰蜜兰单丛改价至 ¥169',
        risk: 'critical',
        productId: 'P-02',
        newPrice: 169,
        expectedImpact: 0.03,
        evidence: ['竞品中位价 ¥328', '当前库存 180 件'],
        requestedBy: 'operator',
        tools: ['pricing.change']
      };
      const veto = this.guardrails.complianceVeto(proposal);
      const card = this.createDecision({
        agent: 'controller',
        action: proposal.action,
        trigger: '运营申请用击穿底价换取短期转化',
        risk: 'critical',
        confidence: 0.99,
        reasoning: `合规哨兵一票否决：${veto.reason}。高风险价格动作被冻结，并已进入人工复核队列。`,
        evidence: [`底价 ¥190`, `申请价 ¥169`, veto.reason],
        consensus: { approved: false, vetoed: true, weight: 0, threshold: 2.4, ballots: [], veto },
        traceId: trace.id,
        latencyMs: round(Date.now() - trace.startedAt, 2),
        status: 'vetoed',
        alternatives: ['改为赠送茶样', '维持原价并加赠品']
      });
      this.bus.logSystem(
        createEnvelope({
          sender: 'compliance',
          receiver: 'orchestrator',
          performative: 'VETO',
          traceId: trace.id,
          priority: 10,
          content: { code: veto.code, reason: veto.reason, proposalId: proposal.id }
        }),
        'price floor veto'
      );
      this.humanQueue.unshift({
        id: uid('HITL'),
        reason: `价格红线被合规否决：${veto.reason}`,
        proposal,
        status: 'open',
        createdAt: Date.now(),
        slaSeconds: 120
      });
      this.tracer.finish(trace, 'blocked', { veto });
      this.emit('scenario', { type, veto, decision: card });
      return { type, veto, decision: card };
    }
    if (type === 'surge') {
      const texts = Array.from({ length: 80 }, (_, i) => DANMAKU_POOL.emoji[i % DANMAKU_POOL.emoji.length]);
      const started = performance.now();
      await Promise.all(
        texts.map((text, index) =>
          this.ingestDanmaku(text, { user: USERS[index % USERS.length], simulated: true, pool: 'emoji' })
        )
      );
      const snapshot = {
        ...this.stream.snapshot(),
        wallMs: round(performance.now() - started, 2),
        events: texts.length,
        passed: this.stream.snapshot().p99 <= this.config.stream.targetP99Ms
      };
      this.loadTest = { ...snapshot, at: Date.now(), mode: 'emoji-surge' };
      this.stressHistory.unshift(this.loadTest);
      this.stressHistory = this.stressHistory.slice(0, 8);
      this.emit('scenario', { type, snapshot });
      return { type, snapshot };
    }
    throw new Error(`未知演练类型：${type}`);
  }

  async stressTest(events = 400) {
    const total = clamp(Number(events) || 400, 50, 3000);
    const texts = [];
    for (let i = 0; i < total; i += 1) {
      const low = i % 5 < 2;
      const pool = low ? 'emoji' : i % 7 === 0 ? 'product' : 'normal';
      const list = DANMAKU_POOL[pool];
      texts.push({
        text: list[i % list.length],
        priority: low ? 'low' : 'normal',
        low
      });
    }
    const engine = new StreamEngine({
      windowMs: this.config.stream.batchWindowMs,
      maxBatch: this.config.stream.maxBatch,
      backpressureQueue: this.config.stream.backpressureQueue,
      emit: () => {},
      handler: async (items) => items.map((item) => this.llm.classify(item.text))
    });
    const started = performance.now();
    await Promise.all(texts.map((item) => engine.ingest(item)));
    const wallMs = round(performance.now() - started, 2);
    const snapshot = engine.snapshot();
    const result = {
      events: total,
      wallMs,
      throughput: round(total / (wallMs / 1000), 1),
      ...snapshot,
      targetP99: this.config.stream.targetP99Ms,
      passed: snapshot.p99 <= this.config.stream.targetP99Ms,
      mode: 'intent-pipeline · 本机实测（不含外部模型网络时延）',
      at: Date.now()
    };
    this.loadTest = result;
    this.stressHistory.unshift(result);
    this.stressHistory = this.stressHistory.slice(0, 8);
    this.emit('loadtest', result);
    return result;
  }

  setAgentFault(agentId, action = 'offline') {
    const target = this.agentList.find((a) => a.id === agentId);
    if (!target) throw new Error(`Unknown agent: ${agentId}`);
    const replica = this.agentList.find(
      (a) => a.replicaOf === target.logicalRole && a.id !== target.id
    );
    if (action === 'offline') {
      target.setStatus('offline');
      if (replica && replica.status !== 'active') replica.setStatus('active');
      const active = this.agentList.filter(
        (a) => a.logicalRole === target.logicalRole && a.status === 'active'
      );
      this.bus.logSystem(
        createEnvelope({
          sender: 'orchestrator',
          receiver: '*',
          performative: 'ESCALATE',
          traceId: `TRC-FAULT-${target.id.toUpperCase()}`,
          priority: 9,
          content: {
            kind: 'fault.injected',
            agent: target.id,
            replica: active[0]?.id ?? null,
            message: active.length
              ? `主实例下线，${active[0].id} 接管`
              : '无可用副本，任务将升级人工'
          }
        }),
        'fault injection'
      );
      this.emit('fault', {
        agent: target.id,
        action,
        active: active.map((a) => a.id),
        replica: replica?.id ?? null
      });
      return {
        agent: target.id,
        status: target.status,
        active: active.map((a) => a.id),
        replica: replica?.id ?? null
      };
    }
    target.setStatus('active');
    if (replica) replica.setStatus('standby');
    this.emit('fault', { agent: target.id, action: 'restore', active: [target.id] });
    return { agent: target.id, status: target.status, active: [target.id], replica: replica?.id ?? null };
  }

  hotplugTool(payload) {
    const name = String(payload.name ?? '').trim();
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(name)) {
      throw new Error('工具名需为反向域名格式，如 market.compare');
    }
    if (this.registry.get(name)) throw new Error('工具名已存在');
    const { spec, handler } = createHotplugTool({
      name,
      description: payload.description ?? '运行时热插拔工具',
      category: payload.category ?? '扩展',
      handlerType: payload.handlerType ?? 'market_compare',
      riskLevel: payload.riskLevel ?? 'low'
    });
    this.registry.register(spec, handler);
    this.emit('tool.registered', { name, spec });
    return this.registry.get(name).spec;
  }

  removeTool(name) {
    return this.registry.unregister(name);
  }

  async callTool(name, args = {}, context = {}) {
    const result = await this.registry.call(name, args, {
      approvalId: args.approvalId,
      traceId: context.traceId ?? null
    });
    return result;
  }

  pushChat(role, text, blocks = [], actions = [], { silent = false } = {}) {
    const message = {
      id: uid('CHT'),
      role,
      text,
      blocks,
      actions,
      at: Date.now()
    };
    this.chatLog.push(message);
    if (this.chatLog.length > 80) this.chatLog.shift();
    if (!silent) this.emit('chat', message);
    return message;
  }

  async chat(input) {
    const text = String(input ?? '').trim().slice(0, 400);
    if (!text) throw new Error('请输入指令');
    const userMessage = this.pushChat('user', text);
    const lower = text.toLowerCase();
    let reply = '';
    let blocks = [];
    let actions = [];
    try {
      if (/恢复|restore/.test(lower) && /(controller|场控|speaker|言枢|实例|agent)/i.test(text)) {
        const result = this.setAgentFault('controller', 'restore');
        this.setAgentFault('speaker', 'restore');
        reply = `已恢复主实例。当前在线：**${result.active.join('、')}**，副本回到热备待命。`;
        actions = [{ label: '查看智能体矩阵', kind: 'navigate', payload: { view: 'agents' } }];
      } else if (/(下线|故障|容灾|转移|failover)/.test(text)) {
        const result = this.setAgentFault('controller', 'offline');
        const contract = await this.contract({
          capability: 'realtime',
          task: '验证故障转移后的实时承接',
          traceId: `TRC-FAULT-CHAT`
        });
        reply = `已下线主 Controller。副本 **${result.replica ?? '无'}** 接管，合同网重新招标的赢家是 **${
          contract.winner ?? '无（已升级人工）'
        }**。业务未中断，A2A 日志已记录改投。`;
        blocks = [
          {
            type: 'kpi',
            items: [
              { label: '主实例', value: 'offline', tone: 'danger' },
              { label: '接管实例', value: result.replica ?? '无', tone: 'ok' },
              { label: '招标赢家', value: contract.winner ?? '人工', tone: 'warn' }
            ]
          }
        ];
        actions = [{ label: '查看协同拓扑', kind: 'navigate', payload: { view: 'agents' } }];
      } else if (/(舆情|负面|香精|农残|危机|质疑)/.test(text)) {
        const result = await this.runScenario('negative');
        const ballots = result.incident?.voteSummary?.ballots ?? [];
        reply = `已注入 3 条信任质疑。Controller 触发高风险动作，经过 ${
          ballots.length
        } 方加权投票，合规前置通过，当前状态：**${result.incident?.status === 'executed' ? '已执行处置' : '被阻断'}**。投票权重 ${
          result.incident?.voteSummary?.weight ?? 0
        } / 阈值 ${result.incident?.voteSummary?.threshold ?? 2.4}。`;
        blocks = [
          {
            type: 'kpi',
            items: [
              { label: '负面条数', value: '3', tone: 'danger' },
              { label: '赞成权重', value: String(result.incident?.voteSummary?.weight ?? 0), tone: 'ok' },
              { label: '处置状态', value: result.incident?.status ?? '-', tone: 'warn' }
            ]
          },
          ...(this.decisions[0] ? [{ type: 'decision', decision: this.decisions[0] }] : [])
        ];
        actions = [{ label: '进入直播中控', kind: 'navigate', payload: { view: 'live' } }];
      } else if (/(极限词|违规|合规|全网最低)/.test(text)) {
        const result = await this.runScenario('extreme');
        const guard = result.result?.result?.response?.guardrail;
        reply = `已触发合规探针。规则引擎命中 **${
          guard?.violations?.length ?? 0
        }** 处违规，输出前已强制改写；本次没有让极限词进入直播间。`;
        blocks = [
          {
            type: 'list',
            title: '拦截明细',
            items: (guard?.violations ?? []).map((v) => ({
              title: v.term,
              desc: v.message,
              badge: 'BLOCKED'
            }))
          },
          ...(this.decisions[0] ? [{ type: 'decision', decision: this.decisions[0] }] : [])
        ];
        actions = [{ label: '查看决策卡片', kind: 'navigate', payload: { view: 'decisions' } }];
      } else if (/(改价|价格红线|底价)/.test(text)) {
        const result = await this.runScenario('price');
        reply = `已发起一次击穿底价的改价申请。合规哨兵直接否决：**${result.veto.reason}**。该动作已冻结并进入人工复核队列。`;
        blocks = [...(this.decisions[0] ? [{ type: 'decision', decision: this.decisions[0] }] : [])];
        actions = [{ label: '查看决策留痕', kind: 'navigate', payload: { view: 'decisions' } }];
      } else if (/(复盘|归因|报告|效果|为什么提升)/.test(text)) {
        if (!['ended', 'reviewed'].includes(this.session.stage)) {
          reply = '本场还在进行中。先结束直播，Analyst 才能基于完整样本做因果归因与 Reflexion。';
          actions = [{ label: '进入直播中控', kind: 'navigate', payload: { view: 'live' } }];
        } else {
          const result = await this.review();
          reply = `${result.report.summary}\n\n因果结论：**${result.report.causal.statement}**`;
          blocks = [
            {
              type: 'kpi',
              items: [
                { label: 'ATT', value: `${(result.report.causal.att * 100).toFixed(2)}pp`, tone: 'ok' },
                { label: 'p 值', value: String(result.report.causal.pValue), tone: 'ok' },
                { label: 'P99', value: `${result.report.latency.p99}ms`, tone: 'ok' }
              ]
            },
            {
              type: 'list',
              title: '下一场动作',
              items: result.report.nextActions.slice(0, 3).map((a) => ({
                title: a.title,
                desc: `${a.owner} · ${a.impact}`,
                badge: 'NEXT'
              }))
            }
          ];
          actions = [{ label: '打开复盘实验室', kind: 'navigate', payload: { view: 'review' } }];
        }
      } else if (/(发券|优惠券|福利)/.test(text)) {
        const result = await this.runScenario('coupon');
        reply = `发券提案已走加权共识：${
          result.vote.approved ? '**通过**' : '**未通过**'
        }，赞成权重 ${result.vote.weight} / 阈值 ${result.vote.threshold}。${
          result.coupon ? `券已发放：${result.coupon.label}。` : '券未发放。'
        }`;
        blocks = [...(this.decisions[0] ? [{ type: 'decision', decision: this.decisions[0] }] : [])];
      } else if (/(压测|性能|并发|延迟|p99)/i.test(text)) {
        const match = text.match(/(\d{2,4})\s*条/);
        const count = match ? Number(match[1]) : 400;
        const result = await this.stressTest(count);
        reply = `已完成 **${result.events}** 条弹幕的本机意图链路压测：P50 **${result.p50}ms**，P95 **${result.p95}ms**，P99 **${result.p99}ms**，吞吐 ${result.throughput}/s，背压丢弃 ${result.dropped} 条。目标 P99 ≤ 500ms：**${
          result.passed ? '通过' : '未通过'
        }**。`;
        blocks = [
          {
            type: 'kpi',
            items: [
              { label: 'P99', value: `${result.p99}ms`, tone: result.passed ? 'ok' : 'danger' },
              { label: '吞吐', value: `${result.throughput}/s`, tone: 'ok' },
              { label: '丢弃', value: String(result.dropped), tone: 'warn' }
            ]
          },
          { type: 'notice', variant: 'info', text: result.mode }
        ];
        actions = [{ label: '查看验收实验室', kind: 'navigate', payload: { view: 'system' } }];
      } else if (/(方案|策划|筹备|排期)/.test(text) && !/(开始|开播)/.test(text)) {
        const result = await this.prepare();
        reply = `方案 **${result.plan.version}** 已定稿：${result.plan.narrative.headline}。${result.plan.narrative.rationale} 全链路耗时 ${result.prepChainMs}ms，命中 ${result.plan.memoryHits.length} 条记忆，并入 ${result.plan.advisories.length} 条三方评审意见。`;
        blocks = [
          {
            type: 'kpi',
            items: [
              { label: '商品数', value: String(result.plan.products.length), tone: 'ok' },
              { label: '排期段', value: String(result.plan.segments.length), tone: 'ok' },
              { label: '链路耗时', value: `${result.prepChainMs}ms`, tone: 'ok' }
            ]
          },
          {
            type: 'list',
            title: '排期骨架',
            items: result.plan.segments.map((s) => ({
              title: `${s.start}–${s.end} min · ${s.label}`,
              desc: `${s.goal} · ${s.style}`,
              badge: s.context
            }))
          }
        ];
        actions = [
          { label: '查看智能体矩阵', kind: 'navigate', payload: { view: 'agents' } },
          { label: '开始直播', kind: 'api', payload: { method: 'POST', path: '/api/live/start' } }
        ];
      } else if (/(开播|开始直播|启动直播)/.test(text)) {
        if (!this.session.plan) {
          reply = '还没有可执行的直播方案。先让我生成方案，或直接让我“生成方案并开播”。';
          actions = [{ label: '生成方案', kind: 'chat', payload: { message: '生成今晚的直播方案' } }];
        } else {
          this.startLive();
          reply = `直播已开始。**${this.session.metrics.viewers}** 人入场，当前主推「${
            this.session.plan.products[0].name
          }」。你可以继续注入弹幕，或让我触发一次舆情演练。`;
          actions = [{ label: '进入直播中控', kind: 'navigate', payload: { view: 'live' } }];
        }
      } else if (/(结束|下播|停播)/.test(text)) {
        this.stopLive();
        reply = '直播已结束，实时链路停止。现在可以让我做本场复盘，Analyst 会输出 ATT、置信区间与 Reflexion。';
        actions = [{ label: '复盘本场', kind: 'chat', payload: { message: '复盘本场，解释发券效果' } }];
      } else if (/(暂停)/.test(text)) {
        this.pauseLive();
        reply = '直播已暂停，弹幕批次停止消费，当前队列保留。';
      } else if (/(继续|恢复直播)/.test(text)) {
        this.resumeLive();
        reply = '直播已恢复，流式引擎重新开始消费弹幕。';
      } else if (/(赌博机|话术风格|学习|bandit)/i.test(text)) {
        const snapshot = this.bandit.snapshot();
        const lines = snapshot.contexts.map((ctx) => {
          const best = [...ctx.arms].sort((a, b) => b.mean - a.mean)[0];
          return { title: `${ctx.context} → ${best.arm}`, desc: `后验均值 ${best.mean} · 样本 ${best.observations}`, badge: 'BANDIT' };
        });
        reply = `当前使用 **Beta Thompson Sampling**，按直播阶段选择话术。累计在线更新 ${snapshot.updates} 次。`;
        blocks = [{ type: 'list', title: '各阶段后验最优', items: lines }];
        actions = [{ label: '查看复盘实验室', kind: 'navigate', payload: { view: 'review' } }];
      } else if (/(工具|mcp|热插拔)/i.test(text)) {
        const tools = this.registry.snapshot();
        const risky = tools.filter((t) => ['high', 'critical'].includes(t.riskLevel));
        reply = `MCP 工具层当前注册 **${tools.length}** 个工具，其中高风险 ${risky.length} 个需要共识审批。新增工具只需一份 Schema 与一个 handler，不改智能体代码。`;
        blocks = [
          {
            type: 'list',
            title: '高风险工具',
            items: risky.map((t) => ({ title: t.name, desc: t.description, badge: t.riskLevel.toUpperCase() }))
          }
        ];
        actions = [{ label: '打开协议工坊', kind: 'navigate', payload: { view: 'protocol' } }];
      } else if (/(为什么|解释|依据)/.test(text)) {
        const card = this.decisions[0];
        if (!card) {
          reply = '当前还没有决策卡片。先生成方案或注入一条弹幕。';
        } else {
          reply = `最近一次动作是 **${card.action}**。触发原因是：${card.trigger}。推理：${card.reasoning}`;
          blocks = [{ type: 'decision', decision: card }];
          actions = [{ label: '查看完整 Trace', kind: 'navigate', payload: { view: 'decisions' } }];
        }
      } else if (/(重置|重来)/.test(text)) {
        this.resetSession();
        reply = '已重置当前演示场次，历史学习与验收记录保留在初始种子中。可以重新生成方案。';
        actions = [{ label: '生成方案', kind: 'chat', payload: { message: '生成今晚的直播方案' } }];
      } else if (/(状态|指标|现在|怎么样|数据)/.test(text)) {
        const m = this.getMetrics();
        reply = `当前阶段 **${m.stage}**。在线 ${m.viewers} 人，GMV ¥${m.gmv.toLocaleString()}，成交 ${m.orders} 单，P99 ${
          m.p99
        }ms。Controller 已处理 ${m.comments} 条弹幕，回应 ${m.responses} 次。`;
        blocks = [
          {
            type: 'kpi',
            items: [
              { label: '在线', value: String(m.viewers), tone: 'ok' },
              { label: 'GMV', value: `¥${m.gmv.toLocaleString()}`, tone: 'ok' },
              { label: 'P99', value: `${m.p99}ms`, tone: m.p99 <= 500 ? 'ok' : 'danger' }
            ]
          }
        ];
      } else if (/(你好|帮助|能做什么|hello|hi)/i.test(text)) {
        reply = '我能直接驱动这个多智能体系统：生成方案、开播、注入弹幕/舆情、触发共识投票、跑压测、下线实例验证容灾、做因果复盘。你也可以问“为什么”，我会给出最近一次决策的证据链。';
        blocks = [
          {
            type: 'list',
            title: '推荐指令',
            items: [
              { title: '生成今晚的直播方案', desc: 'Plan-Execute + 合同网招标', badge: 'PLAN' },
              { title: '注入负面舆情', desc: '加权投票 + 合规前置', badge: 'RISK' },
              { title: '把 Controller 下线', desc: '验证副本接管与任务改投', badge: 'FAULT' },
              { title: '运行 800 条弹幕压测', desc: '实测 P50/P95/P99', badge: 'LOAD' }
            ]
          }
        ];
      } else {
        const m = this.getMetrics();
        reply = `我没有把这句话匹配到具体动作。当前阶段 **${m.stage}**，可以让我：生成方案、开播、注入舆情、发券、压测、复盘、下线实例，或问“为什么”。`;
        actions = [{ label: '生成方案', kind: 'chat', payload: { message: '生成今晚的直播方案' } }];
      }
    } catch (error) {
      reply = `动作没有完成：**${error.message}**。你可以先检查直播状态，或让我“查看状态”。`;
      blocks = [{ type: 'notice', variant: 'warn', text: '命令被安全拦截，系统状态未改变。' }];
    }
    const assistantMessage = this.pushChat('assistant', reply, blocks, actions);
    return { userMessage, message: assistantMessage };
  }

  resetSession() {
    this.session = this.createSession();
    this.memory = new MemorySystem({ episodes: clone(SEED_EPISODES) });
    this.bandit = new BetaBandit({
      contexts: this.config.bandit.contexts,
      arms: this.config.bandit.arms,
      prior: SEED_BANDIT
    });
    this.guardrails = new Guardrails({ config: this.config.guardrails, products: this.products });
    this.tracer = new Tracer({ emit: this.emit });
    this.decisions = [];
    this.metricsHistory = [];
    this.latestReview = null;
    this.reviewIsHistorical = false;
    this.coupon = null;
    this.incident = null;
    this.loadTest = null;
    this.stressHistory = [];
    this.lastConsensus = null;
    this.lastContract = null;
    this.consensusHistory = [];
    this.humanQueue = [];
    this.approvals.clear();
    this.prepMinutes = null;
    this.prepChainMs = null;
    this.blackboard = new Blackboard({ emit: this.emit });
    this.attachStream();
    this.bus.log = [];
    this.bus.counts = { sent: 0, broadcast: 0, rerouted: 0, dropped: 0 };
    for (const agent of this.agentList) {
      agent.status = agent.replicaOf ? 'standby' : 'active';
      agent.mailbox = [];
      agent.handled = 0;
      agent.received = 0;
      agent.lastAction = agent.status === 'standby' ? '热备待命' : '等待任务';
      agent.lastActionAt = null;
      agent.load = agent.status === 'active' ? 0.12 : 0;
      agent.recentEnvelopes = [];
      agent.currentTask = null;
    }
    for (const tool of this.registry.list()) {
      if (tool.source === 'hotplug') {
        try {
          this.registry.unregister(tool.name);
        } catch {
          // builtins are protected; nothing to do
        }
      }
    }
    this.applyHistoricalSeed();
    this.chatLog = [];
    this.pushChat('assistant', '演示已重置。可以重新生成方案、开播并复现全部协同链路。', [], [
      { label: '生成方案', kind: 'chat', payload: { message: '生成今晚的直播方案' } }
    ]);
    this.emit('session', this.sessionSummary());
    this.emit('reset', { at: Date.now() });
    this.publishMetrics();
    return this.sessionSummary();
  }

  sessionSummary() {
    return {
      id: this.session.id,
      title: this.session.title,
      goal: this.session.goal,
      stage: this.session.stage,
      startedAt: this.session.startedAt,
      endedAt: this.session.endedAt,
      metrics: this.getMetrics(),
      planId: this.session.plan?.id ?? null,
      planVersion: this.session.plan?.version ?? null
    };
  }

  snapshot() {
    return {
      meta: {
        name: '智播中枢',
        latin: 'ZHIBO NEXUS',
        version: this.version,
        mode: '本地仿真内核 · local-deterministic',
        llm: this.llm.mode,
        startedAt: this.startedAt,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        autoSimulate: this.autoSimulate,
        architecture: '五层 · 事件驱动 + 协议化'
      },
      session: this.sessionSummary(),
      plan: this.session.plan,
      metrics: this.getMetrics(),
      agents: this.agentList.map((agent) => agent.snapshot()),
      blackboard: this.blackboard.snapshot(),
      messages: this.bus.recent(70),
      busStats: this.bus.stats(),
      decisions: this.decisions.slice(0, 40),
      traces: this.tracer.list(24),
      review: this.latestReview,
      reviewIsHistorical: this.reviewIsHistorical,
      tools: this.registry.snapshot(),
      cnp: this.lastContract,
      consensus: this.lastConsensus,
      consensusHistory: this.consensusHistory.slice(0, 8),
      memory: this.memory.snapshot(),
      bandit: this.bandit.snapshot(),
      guardrails: this.guardrails.snapshot(),
      stream: this.stream.snapshot(),
      loadTest: this.loadTest,
      stressHistory: this.stressHistory.slice(0, 6),
      coupon: this.coupon,
      incident: this.incident,
      humanQueue: this.humanQueue.slice(0, 6),
      config: {
        session: this.config.session,
        stream: this.config.stream,
        consensus: this.config.consensus,
        guardrails: this.config.guardrails,
        bandit: this.config.bandit
      },
      chat: this.chatLog.slice(-40),
      danmaku: this.session.danmaku.slice(-60),
      responses: this.session.responses.slice(-30),
      metricsHistory: this.metricsHistory.slice(-120)
    };
  }

  async runAcceptance() {
    const { runAcceptance } = await import('./acceptance.mjs');
    return runAcceptance(this);
  }
}
