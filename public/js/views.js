import {
  icon,
  esc,
  agentOrb,
  agentInfo,
  badge,
  tag,
  empty,
  pageHead,
  panel,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtMs,
  fmtTime,
  fmtDateTime,
  fmtDuration,
  relTime,
  shortId,
  stageMeta,
  riskMeta,
  statusText,
  formatText,
  safeColor,
  STAGE
} from './ui.js';
import { areaChart, sparkline, causalDag, funnel, waterfall } from './charts.js';
import { topology } from './topology.js';

const RISK_COLOR = {
  critical: 'var(--danger)',
  high: 'var(--amber)',
  medium: 'var(--blue)',
  low: 'var(--mint)'
};

const CAP_LABEL = { planning: '策划', realtime: '实时', copy: '话术', attribution: '归因' };

const INTENT_LABEL = {
  purchase_intent: '购买意图',
  product_question: '商品咨询',
  price_objection: '价格异议',
  authenticity_doubt: '真伪质疑',
  negative_feedback: '负面反馈',
  compliance_probe: '合规探针',
  churn_signal: '流失信号',
  low_value: '低价值'
};

const DIMENSION_LABEL = {
  stage: '阶段',
  sessionId: '场次',
  currentProduct: '当前商品',
  viewers: '在线',
  peakViewers: '峰值',
  gmv: 'GMV',
  orders: '订单',
  interactionRate: '互动率',
  cvr: '转化率',
  sentiment: '情绪',
  riskLevel: '风险',
  latencyP99: 'P99',
  couponActive: '券状态',
  stockRisk: '库存风险',
  version: '版本'
};

function stageOf(state) {
  return state?.session?.stage ?? 'prep';
}

function stageLabel(state) {
  return STAGE[stageOf(state)]?.label ?? stageOf(state);
}

function trendSeries(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(Number(value)));
  if (list.length === 1) return [list[0], list[0]];
  return list;
}

function actionButton(label, action, { iconName = '', tone = '', size = '', data = {}, title = '' } = {}) {
  const attrs = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${esc(String(value))}"`)
    .join('');
  return `<button class="btn ${tone} ${size}" data-act="${action}"${attrs}${
    title ? ` title="${esc(title)}"` : ''
  }>${iconName ? icon(iconName, 14) : ''}<span>${esc(label)}</span></button>`;
}

const FLOW_STEPS = [
  { id: 'prep', label: '筹备', hint: '选品 · 排期 · 话术', view: 'overview' },
  { id: 'launch', label: '开播', hint: '方案锁定 · 开播', view: 'live' },
  { id: 'interact', label: '实时互动', hint: '弹幕 · 反应 · 共识', view: 'live' },
  { id: 'close', label: '下播', hint: '收口 · 留痕', view: 'live' },
  { id: 'review', label: '复盘', hint: '因果 · 经验写回', view: 'review' }
];

function flowIndex(stage) {
  if (stage === 'ready') return 1;
  if (stage === 'live' || stage === 'paused') return 2;
  if (stage === 'ended') return 3;
  if (stage === 'reviewed') return 4;
  return 0;
}

function flowBar(state) {
  const stage = stageOf(state);
  const current = flowIndex(stage);
  const rail = FLOW_STEPS.map(
    (step, index) => `<i class="${index < current ? 'on' : index === current ? 'now' : ''}"></i>`
  ).join('');
  const steps = FLOW_STEPS.map((step, index) => {
    const done = index < current;
    const isCurrent = index === current;
    const status = done ? '已完成' : isCurrent ? '当前阶段' : '待执行';
    return `<button class="flow-step ${done ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''}"
      data-act="navigate" data-view="${step.view}" title="${esc(`${step.label} · ${status}`)}">
      <span class="flow-node">${done ? icon('check', 11) : String(index + 1)}</span>
      <span class="flow-copy"><b>${esc(step.label)}</b><small>${esc(step.hint)}</small></span>
    </button>`;
  }).join('');
  return `<nav class="flow-bar" aria-label="直播全流程">
    <div class="flow-rail" aria-hidden="true">${rail}</div>
    <div class="flow-main">
      <div class="flow-steps">${steps}</div>
      <div class="flow-side">
        <span class="flow-stage">${esc(stageLabel(state))}</span>
        <button class="flow-help" data-act="function-map" title="打开功能地图">${icon('map', 14)}<span>功能地图</span></button>
      </div>
    </div>
  </nav>`;
}

export function primaryAction(state) {
  const stage = stageOf(state);
  if (stage === 'live') {
    return {
      label: '结束直播并复盘',
      act: 'end-review',
      icon: 'stop',
      note: '结束后自动运行 Analyst 复盘，结论写回情景记忆'
    };
  }
  if (stage === 'paused') {
    return { label: '继续直播', act: 'live-resume', icon: 'play', note: '恢复后弹幕批次继续消费' };
  }
  if (stage === 'ended') {
    return { label: '生成复盘报告', act: 'review', icon: 'sparkles', note: 'ATT + Reflexion，约 2 秒出结论' };
  }
  if (stage === 'reviewed') {
    return { label: '重新开播', act: 'live-start', icon: 'play', note: '沿用本场方案，验证复盘后的新策略' };
  }
  if (state.plan) {
    return { label: '开始直播', act: 'live-start', icon: 'play', note: '自动弹幕与成交仿真会同时启动' };
  }
  return { label: '生成直播方案', act: 'prepare', icon: 'sparkles', note: '合同网招标 + Plan-Execute，约 3 秒' };
}

function stageActions(state) {
  const stage = stageOf(state);
  const primary = primaryAction(state);
  const secondary = [];
  if (state.plan) secondary.push(actionButton('查看方案', 'plan', { iconName: 'book', size: 'sm' }));
  if (stage === 'live') secondary.push(actionButton('暂停', 'live-pause', { iconName: 'pause', size: 'sm' }));
  if (stage === 'reviewed') secondary.push(actionButton('更新复盘', 'review', { iconName: 'refresh', size: 'sm' }));
  return [
    actionButton(primary.label, primary.act, { iconName: primary.icon, tone: 'primary', size: 'sm' }),
    ...secondary
  ].join('');
}

function stageNextHint(state) {
  const stage = stageOf(state);
  if (!state.plan) return '还没生成方案。策选会招标分工，产出商品清单、节奏排期和话术。';
  if (stage === 'ready') return '方案已就绪，四个 Actor 按招标结果分工待命。';
  if (stage === 'live') return '本场正在进行，弹幕与成交仿真实时写入指标。';
  if (stage === 'paused') return '弹幕消费已暂停，样本完整保留。';
  if (stage === 'ended') return '本场已下播，样本封存，等待因果复盘。';
  if (stage === 'reviewed') return '复盘结论已写回情景记忆，下一场会自动引用。';
  return '';
}

function kpiHeadline(state) {
  return state.plan?.narrative?.headline ?? state.session?.title ?? '把一整场直播，交给一个中枢';
}

function stageHead(state) {
  const stage = stageOf(state);
  const primary = primaryAction(state);
  const secondary = [];
  if (state.plan) secondary.push(actionButton('查看方案', 'plan', { iconName: 'book', size: 'sm' }));
  if (stage === 'live') secondary.push(actionButton('暂停', 'live-pause', { iconName: 'pause', size: 'sm' }));
  if (stage === 'reviewed') secondary.push(actionButton('更新复盘', 'review', { iconName: 'refresh', size: 'sm' }));
  const elapsed = stage === 'live' ? ` · 已播 ${fmtDuration(state.metrics?.elapsedSec ?? 0)}` : '';
  const meta = state.plan
    ? `方案 ${state.plan.version} · ${state.plan.products?.length ?? 0} 个商品 · ${state.plan.segments?.length ?? 0} 段排期`
    : '尚未生成方案';
  return `<section class="stage-head">
    <div class="stage-head-copy">
      <div class="stage-head-kicker"><span class="stage-pulse"></span>${esc(stageLabel(state))}${esc(
        elapsed
      )}<span class="stage-head-sep">·</span>${esc(meta)}</div>
      <h1 class="stage-head-title">${esc(kpiHeadline(state))}</h1>
      <p class="stage-head-desc">${esc(stageNextHint(state))}</p>
    </div>
    <div class="stage-head-actions">
      <button class="btn primary lg" data-act="${primary.act}">${icon(primary.icon, 15)}<span>${esc(
        primary.label
      )}</span></button>
      <div class="stage-head-ghosts">${secondary.join('')}</div>
      <div class="stage-head-note">${icon('arrowRight', 11)}<span>${esc(primary.note)}</span></div>
    </div>
  </section>`;
}

function deltaOf(series, span = 8) {
  const list = (series ?? []).filter((value) => Number.isFinite(Number(value))).map(Number);
  if (list.length < 2) return null;
  const previous = list[Math.max(0, list.length - 1 - span)];
  const current = list[list.length - 1];
  if (!previous) return null;
  return (current - previous) / previous;
}

function kpiCard({ label, value, unit = '', delta, deltaTone = '', spark = '', foot = '' }) {
  return `<article class="kpi2 ${deltaTone}">
    <div class="kpi2-head">
      <span class="kpi2-label">${esc(label)}</span>
      ${delta ? `<span class="kpi2-delta ${deltaTone}">${esc(delta)}</span>` : ''}
    </div>
    <div class="kpi2-value">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
    <div class="kpi2-spark">${spark}</div>
    <div class="kpi2-foot">${esc(foot)}</div>
  </article>`;
}

function kpiBand(state) {
  const metrics = state.metrics;
  const history = (state.metricsHistory ?? []).slice(-70);
  const orderDelta = deltaOf(history.map((point) => point.orders));
  const viewerDelta = deltaOf(history.map((point) => point.viewers));
  const withinBudget = metrics.p99 <= metrics.latencyTarget;
  const remaining = Math.max(0, metrics.targetGmv - metrics.gmv);
  return `<div class="kpi-band">
    ${kpiCard({
      label: '本场 GMV',
      value: fmtMoney(metrics.gmv),
      delta: `目标完成 ${fmtPct(metrics.progress)}`,
      deltaTone: metrics.progress >= 0.8 ? 'good' : '',
      spark: sparkline(trendSeries(history.map((point) => point.gmv)), { color: '#0b7a5e' }),
      foot: `目标 ${fmtMoney(metrics.targetGmv)} · 还差 ${fmtMoney(remaining)}`
    })}
    ${kpiCard({
      label: '成交订单',
      value: fmtNum(metrics.orders),
      unit: '单',
      delta: orderDelta == null ? '等待采样' : `较 8 次采样前 ${orderDelta >= 0 ? '+' : ''}${(orderDelta * 100).toFixed(1)}%`,
      deltaTone: orderDelta != null && orderDelta >= 0 ? 'good' : '',
      spark: sparkline(trendSeries(history.map((point) => point.orders)), { color: '#a9792f' }),
      foot: `转化率 ${fmtPct(metrics.cvr, 2)} · 客单价 ${fmtMoney(metrics.aov)}`
    })}
    ${kpiCard({
      label: '在线观众',
      value: fmtNum(metrics.viewers),
      unit: '人',
      delta: viewerDelta == null ? '等待采样' : `较 8 次采样前 ${viewerDelta >= 0 ? '+' : ''}${(viewerDelta * 100).toFixed(1)}%`,
      deltaTone: viewerDelta != null && viewerDelta >= 0 ? 'good' : '',
      spark: sparkline(trendSeries(history.map((point) => point.viewers)), { color: '#3f70b4' }),
      foot: `峰值 ${fmtNum(metrics.peakViewers)} · 互动率 ${fmtPct(metrics.interactionRate)}`
    })}
    ${kpiCard({
      label: '流式 P99',
      value: fmtMs(metrics.p99),
      delta: withinBudget ? '预算内' : '超预算',
      deltaTone: withinBudget ? 'good' : 'bad',
      spark: sparkline(trendSeries(history.map((point) => point.p99)), { color: '#bf5062' }),
      foot: `预算 ${metrics.latencyTarget}ms · 批次 ${fmtNum(metrics.batches)}`
    })}
  </div>`;
}

function miniDecision(state, decision) {
  const info = agentInfo(state, decision.agent);
  const risk = riskMeta(decision.risk);
  return `<div class="mini-decision" data-act="decision" data-decision="${esc(decision.id)}">
    ${agentOrb(state, decision.agent, 30)}
    <div class="mini-decision-body">
      <b>${esc(decision.action)}</b>
      <small>${esc(info.cn)} · ${esc(decision.id)} · ${esc(relTime(decision.createdAt))}</small>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
      ${badge(risk.text, risk.tone)}
      ${decision.historical ? badge('历史', 'blue') : ''}
    </div>
  </div>`;
}

function envSummary(env) {
  const content = env?.content ?? {};
  return (
    content.task ??
    content.kind ??
    content.capability ??
    content.action ??
    content.reason ??
    content.message ??
    (content.approved != null ? `approved=${content.approved}` : '') ??
    ''
  );
}

function logLine(state, env) {
  const sender = agentInfo(state, env.sender);
  const receiver = env.receiver === '*' || !env.receiver ? '全体' : agentInfo(state, env.receiver).cn;
  return `<div class="log-line">
    <span class="log-time">${esc(env.createdAt ? fmtTime(env.createdAt) : '—')}</span>
    <span class="log-text"><span class="perf ${esc(env.performative)}">${esc(env.performative)}</span><b>${esc(
      sender.cn
    )}</b><span>→ ${esc(receiver)} · ${esc(String(envSummary(env)).slice(0, 54))}</span></span>
    <span class="log-agents">${esc(shortId(env.traceId, 13))}</span>
  </div>`;
}

function agentsDots(state) {
  return state.agents
    .filter((agent) => !agent.replicaOf)
    .map(
      (agent) => `<span class="scope-agent ${agent.status === 'offline' ? 'offline' : ''}" title="${esc(
        `${agent.name} · ${agent.status === 'active' ? '在线' : agent.status === 'standby' ? '待命' : '离线'}`
      )}">
        <i style="${agent.status === 'active' ? '' : 'background:var(--faint);box-shadow:none'}"></i>
        <span>${esc(agent.name)}</span>
      </span>`
    )
    .join('');
}

function overviewView(state, ui) {
  const metrics = state.metrics;
  const history = (state.metricsHistory ?? []).slice(-70);
  const labels = history.map((point) => fmtTime(point.at));
  const gmvSeries = trendSeries(history.map((point) => point.gmv));
  const plan = state.plan;
  const heroProduct = plan?.products?.[0];

  const top = `${stageHead(state)}${kpiBand(state)}`;

  const chartPanel = panel({
    title: '经营曲线',
    desc: '每 2.8 秒采样 · GMV 来自仿真成交 · 延迟为本机意图链路实测',
    tools: `<span class="scope-agents">${agentsDots(state)}</span>`,
    body: areaChart({
      series: [{ name: 'GMV', color: '#0b7a5e', values: gmvSeries }],
      labels,
      height: 224,
      yFormat: (value) => `¥${Math.round(value / 1000)}k`,
      emptyText: '开播后，这里会形成可回放的经营曲线'
    }),
    foot: `<span>样本 ${history.length} 点</span><span>${esc(
      plan ? `当前主推 ${heroProduct?.name ?? '—'}` : '等待生成方案'
    )}</span>`
  });

  const topoPanel = panel({
    title: '协同拓扑',
    desc: 'A2A 消息总线 · 热备副本 · 负载环',
    tools: `<button class="panel-link" data-act="navigate" data-view="agents">进入矩阵 ${icon('arrowRight', 12)}</button>`,
    body: topology(state.agents, { compact: true }),
    flush: true
  });

  const decisionsPanel = panel({
    title: '决策流',
    desc: '每条决策都带风险级别、置信度与可回溯的 trace',
    tools: `<button class="panel-link" data-act="navigate" data-view="decisions">全部 ${icon('arrowRight', 12)}</button>`,
    body: state.decisions.length
      ? `<div class="decision-feed">${state.decisions.slice(0, 5).map((decision) => miniDecision(state, decision)).join('')}</div>`
      : `${empty('还没有决策', '生成方案或开播后，决策会实时进入这里。', 'decisions')}
         <div class="empty-action">${actionButton('生成直播方案', 'prepare', {
           iconName: 'sparkles',
           tone: 'primary',
           size: 'sm'
         })}</div>`,
    cls: 'reveal reveal-2'
  });

  const quick = (label, desc, action, scenario, view) =>
    `<button class="quick-action" data-act="${action}"${
      scenario ? ` data-scenario="${scenario}"` : ''
    }${view ? ` data-view="${view}"` : ''}>${icon(
      action === 'review' ? 'review' : action === 'stress' ? 'gauge' : action === 'demo' ? 'play' : 'zap',
      16
    )}<b>${esc(label)}</b><small>${esc(desc)}</small></button>`;

  const quickPanel = panel({
    title: '演练与速达',
    desc: '一键复现关键链路；答辩时也可以直接跑完整剧本',
    body: `<div class="quick-grid">
      ${quick('一键演示', '筹备 → 开播 → 互动 → 复盘', 'demo')}
      ${quick('注入负面舆情', 'ReAct · 加权共识 · 信任修复', 'scenario', 'negative')}
      ${quick('触发极限词', '合规前置 · 输出前改写', 'scenario', 'extreme')}
      ${quick('发放优惠券', '高风险审批 · 价格守卫', 'scenario', 'coupon')}
      ${quick('击穿底价', '合规一票否决 · 人工复核', 'scenario', 'price')}
      ${quick('弹幕洪峰', '80ms 批处理 · 背压保护', 'scenario', 'surge')}
    </div>`,
    foot: `<span>需要压测与验收，去「系统验收」</span><button class="panel-link" data-act="navigate" data-view="system">前往 ${icon(
      'arrowRight',
      12
    )}</button>`,
    cls: 'reveal reveal-3'
  });

  const messages = state.messages.slice(0, 7);
  const logPanel = panel({
    title: '消息总线',
    desc: 'CFP → PROPOSE → AWARD → INFORM · trace 全程串联',
    tools: badge(`${state.busStats.sent} 已发送`, 'mint'),
    body: `<div class="scene-log">${messages.length ? messages.map((env) => logLine(state, env)).join('') : empty('总线安静', '开播后消息会持续流入。', 'message')}</div>`,
    flush: true,
    cls: 'reveal reveal-4'
  });

  return `${top}
    <div class="section-divider"><span>明细 · 曲线、协同与决策</span><i></i></div>
    <div class="overview-grid">${chartPanel}${topoPanel}</div>
    <div class="overview-lower">${decisionsPanel}${quickPanel}</div>
    <div style="margin-top:16px">${logPanel}</div>`;
}

function agentCard(state, agent) {
  const accent = safeColor(agent.accent);
  const status = agent.status;
  const caps = Object.entries(agent.capabilities ?? {});
  const isReplica = Boolean(agent.replicaOf);
  return `<article class="agent-card ${status === 'offline' ? 'is-offline' : ''} ${
    status === 'standby' ? 'is-standby' : ''
  }" style="--accent:${accent}" data-act="agent" data-agent="${esc(agent.id)}">
    <div class="agent-card-head">
      ${agentOrb(state, agent.id, 40)}
      <div class="agent-id">
        <h3>${esc(agent.name)}</h3>
        <p>${esc(agent.latin)} · ${esc(agent.title)}${isReplica ? ' · REPLICA' : ''}</p>
      </div>
      <span class="agent-status ${status}">${status === 'active' ? '在线' : status === 'standby' ? '待命' : '离线'}</span>
    </div>
    <p class="agent-desc">${esc(agent.description)}</p>
    <div class="agent-capabilities">${caps
      .map(
        ([key, value]) => `<div class="cap-item">
          <span>${esc(CAP_LABEL[key] ?? key)}</span>
          <strong>${Math.round(value * 100)}</strong>
          <div class="cap-bar"><i style="width:${Math.round(value * 100)}%"></i></div>
        </div>`
      )
      .join('')}</div>
    <div class="agent-load">
      <span>负载</span>
      <div class="progress"><i style="width:${Math.round((agent.load ?? 0) * 100)}%"></i></div>
      <b>${Math.round((agent.load ?? 0) * 100)}%</b>
    </div>
    <div class="agent-foot">
      <span>处理 <b>${agent.handled}</b> / 收件 <b>${agent.received}</b></span>
      <span>W <b>${agent.weight}</b> · ${esc(agent.cognition)}</span>
    </div>
    <div class="agent-load" style="margin-top:6px">
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--faint)">${esc(
        agent.currentTask ?? agent.lastAction
      )}</span>
      <b>${agent.mailbox ? `${agent.mailbox} 待处理` : '空闲'}</b>
    </div>
  </article>`;
}

function agentsView(state, ui) {
  const head = pageHead({
    eyebrow: '对等协同',
    title: '四个 Actor，一套可接管的分工',
    desc: '没有中心大脑。方案通过合同网招标产生，实时事件由场控触发并进入加权共识；主实例下线时副本自动接管。',
    actions: [
      actionButton('下线场控', 'fault', { iconName: 'alert', tone: 'danger', size: 'sm', data: { agent: 'controller', mode: 'offline' } }),
      actionButton('下线言枢', 'fault', { iconName: 'alert', size: 'sm', data: { agent: 'speaker', mode: 'offline' } }),
      actionButton('恢复全部', 'restore-all', { iconName: 'refresh', tone: 'primary', size: 'sm' })
    ].join('')
  });

  const cnp = state.cnp;
  const bidPanel = panel({
    title: '合同网招标 · CNP',
    desc: cnp ? `${cnp.capability} · ${cnp.task ?? '实时任务'}` : '等待下一次任务招标',
    tools: cnp?.winner ? badge(`中标 ${agentInfo(state, cnp.winner).cn}`, 'mint') : badge('待命', ''),
    body: cnp?.bids?.length
      ? `<div class="bid-list">${cnp.bids
          .map((bid) => {
            const max = Math.max(...cnp.bids.map((item) => item.score), 0.01);
            return `<div class="bid-row ${bid.agent === cnp.winner ? 'is-winner' : ''}">
              <span>${esc(agentInfo(state, bid.agent).cn)}</span>
              <span class="bid-bar"><i style="width:${((bid.score / max) * 100).toFixed(1)}%"></i></span>
              <b>${Number(bid.score).toFixed(3)}</b>
            </div>`;
          })
          .join('')}</div>`
      : empty('尚未发生招标', '生成方案时会触发第一次 CFP。', 'flow'),
    foot: `<span>评分 = 能力 62% + 可用性 23% + 可靠性 15%</span><span>${esc(
      cnp?.at ? fmtDateTime(cnp.at) : ''
    )}</span>`
  });

  const memory = state.memory;
  const working = Object.entries(memory.working ?? {});
  const memoryPanel = panel({
    title: '三层记忆',
    desc: '工作记忆 · 情景记忆 · 语义图谱',
    tools: badge(`EPISODIC ${memory.episodicCount}`, 'blue'),
    body: `<div>
      ${working
        .slice(0, 4)
        .map(
          ([agentId, items]) =>
            `<div class="memory-line">${icon('brain', 13)}<span>${esc(agentInfo(state, agentId).cn)} · ${
              items?.[0]?.summary ?? items?.[0]?.kind ?? '暂无工作记忆'
            }</span><b>${items.length} 条</b></div>`
        )
        .join('')}
      <div class="memory-line">${icon('database', 13)}<span>语义图谱 · ${memory.graph.nodes} 节点 / ${
      memory.graph.edges
    } 条关系</span><b>关系图</b></div>
      ${(memory.recentEpisodes ?? [])
        .slice(0, 2)
        .map(
          (episode) =>
            `<div class="memory-line">${icon('book', 13)}<span>${esc(episode.title)} · ${esc(
              episode.outcome
            )}</span><b>${esc(episode.date ?? '')}</b></div>`
        )
        .join('')}
    </div>`,
    foot: `<span>检索策略：字符 n-gram 余弦 + 时间衰减</span><span>写入发生在复盘</span>`
  });

  const topo = panel({
    title: '协同拓扑 · 全量',
    desc: '实心节点为主实例，虚线连接热备副本；点击节点查看详情',
    tools: badge('A2A · 版本化消息总线', 'mint'),
    body: topology(state.agents, { compact: false }),
    flush: true
  });

  const incident = state.incident
    ? `<div class="live-banner">${icon('alert', 16)}<span>舆情事件 ${esc(state.incident.id)} · 负面 ${
        state.incident.count
      } 条 · ${state.incident.status === 'executed' ? '处置已执行' : '处置状态待确认'}</span>${badge(
        '共识',
        'amber'
      )}</div>`
    : '';

  return `${head}${incident}
    <div class="agent-grid">${state.agents.map((agent) => agentCard(state, agent)).join('')}</div>
    <div class="grid-2" style="margin-top:16px">${bidPanel}${memoryPanel}</div>
    <div style="margin-top:16px">${topo}</div>`;
}

function danmakuItem(state, item, responses) {
  const response = responses.get(item.id);
  const intent = response?.intent;
  const intentLabel = INTENT_LABEL[intent] ?? (item.pool === 'negative' ? '负面' : item.pool === 'purchase' ? '购买' : '');
  const warn = response && ['authenticity_doubt', 'negative_feedback', 'compliance_probe'].includes(response.intent);
  return `<div class="danmaku-item">
    <span class="avatar">${esc(String(item.user ?? '客').slice(0, 1))}</span>
    <div class="body">
      <div class="meta"><span>${esc(item.user ?? '匿名')}</span><span>${esc(fmtTime(item.at))}</span>${
        intentLabel ? `<span class="intent ${warn ? 'warn' : ''}">${esc(intentLabel)}</span>` : ''
      }</div>
      <p>${esc(item.text)}</p>
    </div>
  </div>`;
}

function liveView(state, ui) {
  const head = pageHead({
    eyebrow: '实时中控',
    title: '在一个流里，完成观察与反应',
    desc: '弹幕以 80ms 动态批处理进入；场控先判定意图与风险，言枢再生成话术，任何输出都先过合规。',
    actions: stageActions(state)
  });

  if (!state.plan) {
    return `${head}<div class="panel"><div class="panel-body">${empty(
      '尚未生成直播方案',
      '先由策选通过 Plan-Execute 生成商品、排期、福利与话术，再进入直播中控。',
      'live'
    )}<div class="empty-action">${actionButton(
      '生成直播方案',
      'prepare',
      { iconName: 'sparkles', tone: 'primary' }
    )}</div></div></div>`;
  }

  const stage = stageOf(state);
  const metrics = state.metrics;
  const plan = state.plan;
  const hero = plan.products?.[0];
  const elapsedMin = metrics.elapsedSec / 60;
  const segments = plan.segments ?? [];
  const activeSegment = segments.findIndex((segment) => elapsedMin >= segment.start && elapsedMin < segment.end);
  const responses = new Map((state.responses ?? []).map((response) => [response.danmakuId, response]));
  const recentDanmaku = (state.danmaku ?? []).slice(-26);
  const floats = (state.danmaku ?? []).slice(-4);

  const banner =
    stage === 'ready'
      ? `<div class="live-banner">${icon('clock', 16)}<span>方案 ${esc(plan.version)} 已就绪。开始直播后，自动弹幕与成交仿真会启动；所有指标标注为演示数据。</span>${actionButton(
          '立即开播',
          'live-start',
          { iconName: 'play', tone: 'primary', size: 'sm' }
        )}</div>`
      : stage === 'ended' || stage === 'reviewed'
        ? `<div class="live-banner">${icon('review', 16)}<span>本场已下播。去做一次复盘，把节奏、发券时点与舆情处置写成下一场 SOP。</span>${actionButton(
            '进入复盘',
            'navigate',
            { iconName: 'arrowRight', tone: 'primary', size: 'sm', data: { view: 'review' } }
          )}</div>`
        : state.incident
          ? `<div class="live-banner">${icon('alert', 16)}<span>舆情事件 ${esc(state.incident.id)} · 负面 ${
              state.incident.count
            } 条 · 处置 ${esc(state.incident.status ?? '')} · 投票权重 ${
              state.incident.voteSummary?.weight ?? 0
            } / ${state.incident.voteSummary?.threshold ?? 2.4}</span>${state.coupon ? badge('补偿券已发', 'amber') : ''}</div>`
          : '';

  const stagePanel = `<div class="stage-panel">
    <div class="stage-sheen" aria-hidden="true"></div>
    <div class="stage-top">
      <span class="live-pill"><i></i>${stage === 'live' ? '直播中 · 推流' : stage === 'paused' ? '已暂停' : '待命'}</span>
      <span class="stage-clock">${fmtDuration(metrics.elapsedSec)} / ${plan ? `${state.config.session.durationMin}:00` : '—:—'}</span>
    </div>
    <div class="stage-floats">
      ${floats
        .map(
          (item, index) => `<div class="danmaku-float pos-${index + 1}"><b>${esc(item.user ?? '观众')}</b>${esc(
            String(item.text).slice(0, 30)
          )}</div>`
        )
        .join('')}
    </div>
    <div class="stage-product">
      <div class="stage-product-copy">
        <div class="kicker">当前讲解 · ${esc(segments[activeSegment]?.label ?? '主推')}</div>
        <h2>${esc(hero?.name ?? '—')}</h2>
        <p>${esc(hero?.spec ?? '')} · ${esc(hero?.origin ?? '')}</p>
        <div class="tag-row" style="margin-top:8px">${(hero?.tags ?? []).map((item) => tag(item)).join('')}</div>
      </div>
      <div class="stage-price">
        <small>本场价</small>
        <strong>${fmtMoney(hero?.price ?? 0)}</strong>
        <span>${state.coupon ? esc(state.coupon.label) : '讲解中 · 券待触发'}</span>
      </div>
    </div>
    <div class="stage-queue">${segments
      .slice(0, 4)
      .map(
        (segment, index) => `<div class="queue-item ${index === Math.max(0, activeSegment) ? 'active' : ''}">
          <span>${String(segment.start).padStart(2, '0')}–${String(segment.end).padStart(2, '0')} MIN</span>
          <b>${esc(segment.label)}</b>
          <em>${esc(segment.style ?? '')}</em>
        </div>`
      )
      .join('')}</div>
  </div>`;

  const side = `<div class="live-side">
    <div class="live-metrics">
      <div class="live-metric"><span>在线观众</span><strong>${fmtNum(metrics.viewers)}</strong><em>峰值 ${fmtNum(
        metrics.peakViewers
      )}</em></div>
      <div class="live-metric"><span>GMV</span><strong>${fmtMoney(metrics.gmv)}</strong><em>${fmtPct(
        metrics.progress
      )} 目标</em></div>
      <div class="live-metric"><span>转化率</span><strong>${fmtPct(metrics.cvr, 2)}</strong><em>订单 ${fmtNum(
        metrics.orders
      )}</em></div>
      <div class="live-metric"><span>P99</span><strong>${fmtMs(metrics.p99)}</strong><em class="${
        metrics.p99 <= metrics.latencyTarget ? '' : 'danger'
      }">预算 ${metrics.latencyTarget}ms</em></div>
    </div>
    <div class="danmaku-panel">
      <div class="danmaku-panel-head"><b>弹幕流</b><span class="mono dim" style="font-size:10.5px">${fmtNum(
        metrics.comments
      )} 条 · 负面 ${fmtNum(metrics.negative)}</span></div>
      <div class="danmaku-stream" data-autoscroll="danmaku">${
        recentDanmaku.length
          ? recentDanmaku.map((item) => danmakuItem(state, item, responses)).join('')
          : empty('等待第一条弹幕', stage === 'live' ? '自动弹幕会在数秒内出现。' : '开始直播后可注入弹幕。', 'message')
      }</div>
      <div class="danmaku-compose">
        <form class="danmaku-input-row" data-form="danmaku">
          <input class="input" name="text" data-keep="danmaku" maxlength="120" placeholder="以观众身份注入一条弹幕…" ${
            stage !== 'live' ? 'disabled' : ''
          } />
          <button class="btn primary sm" type="submit" ${stage !== 'live' ? 'disabled' : ''}>${icon('send', 13)}注入</button>
        </form>
        <div class="quick-scenarios">
          ${[
            ['舆情三连', 'negative'],
            ['极限词', 'extreme'],
            ['发券', 'coupon'],
            ['击穿底价', 'price'],
            ['弹幕洪峰', 'surge']
          ]
            .map(
              ([label, scenario]) =>
                `<button class="chip" data-act="scenario" data-scenario="${scenario}">${esc(label)}</button>`
            )
            .join('')}
        </div>
      </div>
    </div>
  </div>`;

  const latencyHistory = (state.metricsHistory ?? []).slice(-60);
  const latencyPanel = panel({
    title: '流式处理时延',
    desc: '动态批处理 · 低价值降级 · 背压保护',
    tools: badge(`TARGET ≤ ${state.config.stream.targetP99Ms}ms`, metrics.p99 <= metrics.latencyTarget ? 'mint' : 'danger'),
    body: `<div class="latency-grid">
      <div>${areaChart({
        series: [
          { name: 'P50', color: '#0b7a5e', values: trendSeries(latencyHistory.map((point) => point.p50)) },
          { name: 'P95', color: '#a9792f', values: trendSeries(latencyHistory.map((point) => point.p95)) },
          { name: 'P99', color: '#3f70b4', values: trendSeries(latencyHistory.map((point) => point.p99)) }
        ],
        labels: latencyHistory.map((point) => fmtTime(point.at)),
        height: 196,
        yFormat: (value) => `${value.toFixed(0)}ms`,
        emptyText: '开播后开始采样意图链路时延'
      })}</div>
      <div class="latency-stats">
        <div class="latency-stat"><span>P50</span><strong>${fmtMs(metrics.p50)}</strong><small>批内中位</small></div>
        <div class="latency-stat"><span>P95</span><strong>${fmtMs(metrics.p95)}</strong><small>长尾观察</small></div>
        <div class="latency-stat"><span>P99</span><strong>${fmtMs(metrics.p99)}</strong><small>目标 ${metrics.latencyTarget}ms</small></div>
        <div class="latency-stat"><span>批次数</span><strong>${fmtNum(metrics.batches)}</strong><small>80ms 窗口</small></div>
        <div class="latency-stat"><span>背压队列</span><strong>${metrics.queue}</strong><small>上限 ${state.config.stream.backpressureQueue}</small></div>
        <div class="latency-stat"><span>降级丢弃</span><strong>${fmtNum(metrics.dropped)}</strong><small>低价值优先</small></div>
      </div>
    </div>`,
    cls: 'latency-panel'
  });

  const responseList = (state.responses ?? []).slice(-4).reverse();
  const inspector = panel({
    title: '响应检查器',
    desc: '最近四条回应 · 意图、动作、话术与护栏',
    tools: badge('ReAct', 'blue'),
    body: responseList.length
      ? `<div class="response-inspector">${responseList
          .map(
            (response) => `<div class="inspector-row" style="flex-direction:column;gap:7px;padding:12px 0">
              <div style="display:flex;align-items:center;gap:8px;width:100%">
                ${badge(INTENT_LABEL[response.intent] ?? response.intent, response.risk === 'high' ? 'danger' : 'blue')}
                ${badge(statusText(response.status), response.status === 'executed' ? 'mint' : 'amber')}
                <span class="mono dim" style="margin-left:auto;font-size:10px">${esc(response.user)} · ${fmtMs(
                  response.latencyMs
                )} · ${esc(shortId(response.traceId, 14))}</span>
              </div>
              <div class="inspector-row" style="padding:0;border:0;width:100%"><span>原弹幕</span><b>${esc(
                response.text
              )}</b></div>
              <div class="inspector-row" style="padding:0;border:0;width:100%"><span>动作</span><b>${esc(
                response.actionLabel
              )}</b></div>
              ${
                response.script
                  ? `<div class="inspector-script">${esc(response.script)}</div>`
                  : '<div class="mono dim" style="font-size:10.5px">低价值弹幕不占用生成资源</div>'
              }
              ${
                response.guardrail
                  ? `<div class="mono" style="font-size:10px;color:${
                      response.guardrail.violations?.length ? 'var(--danger)' : 'var(--mint)'
                    }">GUARDRAIL · ${response.guardrail.violations?.length ?? 0} 处命中 · ${
                      response.guardrail.pass ? '通过' : '已改写'
                    }</div>`
                  : ''
              }
            </div>`
          )
          .join('')}</div>`
      : empty('还没有实时响应', '开播并注入一条弹幕，观察 ReAct 链路。', 'zap'),
    cls: 'reveal reveal-2'
  });

  return `${head}${banner}
    <div class="live-layout">${stagePanel}${side}</div>
    ${latencyPanel}
    ${inspector}`;
}

function decisionCard(state, decision) {
  const info = agentInfo(state, decision.agent);
  const risk = riskMeta(decision.risk);
  return `<article class="decision-card" style="--risk-color:${RISK_COLOR[decision.risk] ?? 'var(--mint)'}" data-act="decision" data-decision="${esc(
    decision.id
  )}">
    <div class="decision-top">
      ${agentOrb(state, decision.agent, 30)}
      <div class="decision-main">
        <h4>${esc(decision.action)}</h4>
        <p>${esc(decision.trigger)}</p>
        <div class="decision-badges">
          ${badge(risk.text, risk.tone)}
          ${badge(statusText(decision.status), decision.status === 'executed' ? 'mint' : decision.status === 'vetoed' || decision.status === 'blocked' ? 'danger' : 'amber')}
          ${decision.consensus ? badge(`W ${decision.consensus.weight ?? 0}`, decision.consensus.approved ? 'mint' : 'danger') : ''}
          ${decision.historical ? badge('历史', 'blue') : ''}
        </div>
      </div>
    </div>
    <div class="decision-meta">
      <span>${esc(info.cn)} · 置信度 ${(Number(decision.confidence) * 100).toFixed(0)}%</span>
      <span>${esc(shortId(decision.traceId, 15))} · ${esc(relTime(decision.createdAt))}</span>
    </div>
  </article>`;
}

function decisionsView(state, ui) {
  const query = (ui.decisionSearch ?? '').trim().toLowerCase();
  const agentFilter = ui.decisionAgent ?? 'all';
  const riskFilter = ui.decisionRisk ?? 'all';
  const decisions = state.decisions.filter((decision) => {
    if (agentFilter !== 'all' && decision.agent !== agentFilter) return false;
    if (riskFilter !== 'all' && decision.risk !== riskFilter) return false;
    if (!query) return true;
    return [decision.action, decision.trigger, decision.reasoning, decision.id, decision.traceId]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });

  const head = pageHead({
    eyebrow: '决策留痕',
    title: '每一个动作，都能被追问到底',
    desc: '决策卡片记录触发条件、证据、置信度、共识权重与 trace；高风险动作先过共识，再过审批，才允许调用工具。',
    actions: [
      actionButton('刷新状态', 'refresh', { iconName: 'refresh', size: 'sm' }),
      actionButton('跑一轮压测', 'stress', { iconName: 'gauge', size: 'sm', data: { events: 800 } })
    ].join('')
  });

  const filters = `<div class="filters">
    <input class="input" data-keep="decision-search" data-act="decision-search" placeholder="搜索动作 / 证据 / trace_id" value="${esc(
      ui.decisionSearch ?? ''
    )}" />
    <select class="select" data-keep="decision-agent" data-act="decision-agent">
      <option value="all">全部智能体</option>
      ${['selector', 'controller', 'speaker', 'analyst']
        .map(
          (agent) =>
            `<option value="${agent}" ${agentFilter === agent ? 'selected' : ''}>${esc(
              agentInfo(state, agent).cn
            )}</option>`
        )
        .join('')}
    </select>
    ${[
      ['all', '全部风险'],
      ['low', '低'],
      ['medium', '中'],
      ['high', '高'],
      ['critical', '红线']
    ]
      .map(
        ([value, label]) =>
          `<button class="chip ${riskFilter === value ? 'active' : ''}" data-act="decision-risk" data-risk="${value}">${esc(
            label
          )}</button>`
      )
      .join('')}
    <span class="mono dim" style="margin-left:auto;font-size:10.5px">${decisions.length} / ${state.decisions.length} 条</span>
  </div>`;

  const list = `<div>${
    decisions.length
      ? decisions.map((decision) => decisionCard(state, decision)).join('')
      : `${empty('没有匹配的决策', '试试放宽筛选条件，或生成新的任务。', 'filter')}
         <div class="empty-action">${
           state.decisions.length
             ? actionButton('清除筛选', 'decision-clear', { iconName: 'refresh', size: 'sm' })
             : actionButton('生成直播方案', 'prepare', { iconName: 'sparkles', tone: 'primary', size: 'sm' })
         }</div>`
  }</div>`;
  const trace = state.traces[0];
  const tracePanel = panel({
    title: 'Trace 追踪',
    desc: 'Span 级耗时 · 点击查看完整链路',
    tools: badge(`${state.traces.length} TRACES`, 'blue'),
    body: state.traces.length
      ? `<div class="trace-rail">${state.traces
          .slice(0, 6)
          .map(
            (item) => `<div class="trace-mini" data-act="trace" data-trace="${esc(item.id)}">
              <div class="trace-mini-head"><b>${esc(item.name)}</b><span>${esc(
                item.status === 'running' ? '执行中' : fmtMs(item.durationMs)
              )}</span></div>
              <p>${esc(item.id)} · ${esc(item.meta?.mode ?? '')}</p>
              <div class="trace-mini-stats"><span>${item.spans?.length ?? 0} spans</span><span>${esc(
                item.meta?.sessionId ?? ''
              )}</span><span>${esc(item.startedAt ? fmtDateTime(item.startedAt) : '')}</span></div>
            </div>`
          )
          .join('')}</div>`
      : empty('暂无 trace', '任务开始后自动收集。', 'flow'),
    foot: trace
      ? `<span>最新 ${esc(trace.id)}</span><button class="panel-link" data-act="trace" data-trace="${esc(
          trace.id
        )}">查看瀑布 ${icon('arrowRight', 12)}</button>`
      : ''
  });

  const consensus = state.consensus;
  const consensusPanel = panel({
    title: '共识与合规',
    desc: '权重阈值 2.4 · 合规拥有绝对否决',
    tools: consensus ? badge(consensus.approved ? '共识通过' : '已阻断', consensus.approved ? 'mint' : 'danger') : badge('无投票'),
    body: consensus
      ? `<div class="consensus-box">
          <div class="consensus-head">
            <strong>${consensus.vetoed ? '合规否决' : consensus.approved ? '加权共识通过' : '未达阈值'}</strong>
            <span class="consensus-weight">${consensus.weight ?? 0} / ${consensus.threshold ?? 2.4}</span>
          </div>
          <div class="ballot-list">${
            consensus.ballots?.length
              ? consensus.ballots
                  .map(
                    (ballot) => `<div class="ballot">
                      <b>${esc(agentInfo(state, ballot.agent).cn)}</b>
                      <span class="${ballot.approve ? 'vote-yes' : 'vote-no'}">${ballot.approve ? '赞成' : '反对'}</span>
                      <em>w ${ballot.weight}</em>
                    </div>`
                  )
                  .join('')
              : '<div class="mono dim" style="font-size:10.5px">合规哨兵直接否决，未进入投票。</div>'
          }</div>
        </div>`
      : empty('还没有投票记录', '触发一次高风险动作即可观察。', 'shield'),
    foot: `<span>${esc(consensus?.compliance?.reason ?? '审批 ID 绑定工具与 10 分钟有效期')}</span>`
  });

  const vetoes = state.guardrails.vetoes ?? [];
  const vetoPanel = panel({
    title: '护栏与人工队列',
    desc: '越线即冻结 · 人工可复核',
    tools: badge(`${state.humanQueue.length} HITL`, state.humanQueue.length ? 'amber' : ''),
    body: `<div>
      ${
        vetoes.length
          ? vetoes
              .slice(0, 3)
              .map(
                (veto) => `<div class="memory-line">${icon('shield', 13)}<span>${esc(veto.reason)}</span><b>${esc(
                  veto.code ?? ''
                )}</b></div>`
              )
              .join('')
          : `<div class="mono dim" style="font-size:10.5px;padding:6px 0">本场尚未触发价格 / 合规红线。</div>`
      }
      ${
        state.humanQueue.length
          ? state.humanQueue
              .slice(0, 3)
              .map(
                (ticket) => `<div class="memory-line">${icon('users', 13)}<span>${esc(
                  ticket.reason
                )}</span><b>${esc(ticket.id)}</b></div>`
              )
              .join('')
          : ''
      }
    </div>`,
    foot: `<span>所有 VETO / ESCALATE 已写入总线</span><span>${state.busStats.dropped} dropped</span>`
  });

  return `${head}${filters}
    <div class="decision-layout">
      <div>${list}</div>
      <div style="display:flex;flex-direction:column;gap:16px">${tracePanel}${consensusPanel}${vetoPanel}</div>
    </div>`;
}

function banditGrid(state) {
  const contexts = state.bandit.contexts ?? [];
  const arms = state.config.bandit.arms ?? [];
  if (!contexts.length) return empty('赌博机尚未初始化', '', 'target');
  return `<div class="bandit-wrap"><div class="bandit-grid" style="grid-template-columns:76px repeat(${arms.length}, minmax(0,1fr))">
    <div class="bandit-head"></div>
    ${arms.map((arm) => `<div class="bandit-head">${esc(arm)}</div>`).join('')}
    ${contexts
      .map(
        (row) => `<div class="bandit-head" style="justify-content:flex-start">${esc(row.context)}</div>
        ${row.arms
          .map((cell) => {
            const best = cell.arm === row.chosen;
            return `<div class="bandit-cell ${best ? 'best' : ''}" style="--heat:${Math.min(
              0.28,
              Math.max(0.02, cell.mean * 0.34)
            ).toFixed(3)}" title="α ${cell.alpha} / β ${cell.beta}">
              <span>${(cell.mean * 100).toFixed(0)}%</span><small>n${cell.observations}</small>
            </div>`;
          })
          .join('')}`
      )
      .join('')}
  </div></div>`;
}

function reviewView(state, ui) {
  const report = state.review;
  const head = pageHead({
    eyebrow: '因果复盘',
    title: '不从结果编故事，从证据找原因',
    desc: '用随机分流估计 ATT，用置信区间判断显著性；再把结论写回记忆，让下一场从上一场开始。',
    actions: [
      stageOf(state) === 'ended' || stageOf(state) === 'reviewed'
        ? actionButton('运行本场复盘', 'review', { iconName: 'sparkles', tone: 'primary', size: 'sm' })
        : actionButton('去开播', 'navigate', { iconName: 'play', size: 'sm', data: { view: 'live' } }),
      actionButton('系统验收', 'navigate', { iconName: 'shield', size: 'sm', data: { view: 'system' } })
    ].join('')
  });

  if (!report) {
    const canReview = stageOf(state) === 'ended' || stageOf(state) === 'reviewed';
    return `${head}<div class="panel"><div class="panel-body">${empty(
      '还没有可复盘的场次',
      '结束直播后，Analyst 会用完整样本做因果归因与 Reflexion，并写回情景记忆。',
      'review'
    )}<div class="empty-action">${
      canReview
        ? actionButton('运行本场复盘', 'review', { iconName: 'sparkles', tone: 'primary' })
        : actionButton('去直播中控开播', 'navigate', {
            iconName: 'play',
            tone: 'primary',
            data: { view: 'live' }
          })
    }</div></div></div>`;
  }

  const causal = report.causal ?? {};
  const kpis = report.kpis ?? {};
  const historical = state.reviewIsHistorical;
  const banner = historical
    ? `<div class="live-banner">${icon('book', 16)}<span>当前展示的是历史样本「${esc(
        report.title
      )}」。它用于说明复盘结构；完成本场直播并下播后，运行复盘会生成本场报告。</span>${badge('历史示例', 'blue')}</div>`
    : '';

  const hero = `<div class="review-hero">
    <section class="review-statement reveal">
      <div class="kicker">反思结论 · ${esc(report.id ?? '')}</div>
      <h2>${esc(report.reflexion ?? report.summary ?? '')}</h2>
      <p>${esc(report.summary ?? '')}</p>
      <div class="review-meta">
        <span>场次 ${esc(report.sessionId ?? '')}</span>
        <span>链路 ${esc(shortId(report.traceId, 16))}</span>
        <span>生成于 ${esc(fmtDateTime(report.generatedAt))}</span>
        <span>数据 · 仿真样本</span>
        ${historical ? '<span>历史示例</span>' : ''}
      </div>
    </section>
    <aside class="att-panel reveal reveal-1">
      <div class="kicker">平均处理效应（ATT）</div>
      <div class="att-value">${causal.att >= 0 ? '+' : ''}${((causal.att ?? 0) * 100).toFixed(2)}<small>pp</small></div>
      <div style="display:flex;gap:6px;margin-top:9px;flex-wrap:wrap">
        ${badge(causal.verdict ?? '待估计', causal.significant ? 'mint' : 'amber')}
        ${badge('95% 置信区间', 'blue')}
      </div>
      <div class="att-grid">
        <div><span>相对提升</span><b>${causal.relative != null ? `+${(causal.relative * 100).toFixed(1)}%` : '—'}</b></div>
        <div><span>P 值</span><b>${causal.pValue ?? '—'}</b></div>
        <div><span>Z 值</span><b>${causal.z ?? '—'}</b></div>
      </div>
      <div class="mono dim" style="margin-top:12px;font-size:10px;line-height:1.7">${esc(
        causal.statement ?? ''
      )}</div>
    </aside>
  </div>`;

  const kpiStrip = `<div class="kpi-strip reveal reveal-2">
    ${[
      ['GMV', fmtMoney(kpis.gmv)],
      ['订单', fmtNum(kpis.orders)],
      ['转化率', fmtPct(kpis.cvr, 2)],
      ['互动率', fmtPct(kpis.interactionRate)],
      ['客单价', fmtMoney(kpis.aov)],
      ['峰值在线', fmtNum(kpis.peakViewers)]
    ]
      .map(
        ([label, value]) =>
          `<div class="live-metric"><span>${label}</span><strong>${value}</strong><em>本场 / 仿真</em></div>`
      )
      .join('')}
  </div>`;

  const dagPanel = panel({
    title: '因果图 · DAG',
    desc: '随机分流切断「流量 → 干预」的混杂路径',
    tools: badge(causal.method ?? 'A/B', 'blue'),
    body: causalDag(causal.dag),
    foot: `<span>${esc(causal.intervention ?? '')}</span><span>ATT ${((causal.att ?? 0) * 100).toFixed(2)}pp</span>`
  });

  const attDetail = `<div class="consensus-box" style="height:100%">
    <div class="consensus-head"><strong>样本与区间</strong><span class="consensus-weight">n = ${fmtNum(
      causal.treated?.n ?? 0
    )} × 2</span></div>
    <div class="att-grid" style="border-top:0;margin-top:12px;padding-top:0">
      <div><span>实验组</span><b>${fmtNum(causal.treated?.conversions)} / ${fmtNum(causal.treated?.n)}</b></div>
      <div><span>对照组</span><b>${fmtNum(causal.control?.conversions)} / ${fmtNum(causal.control?.n)}</b></div>
      <div><span>95% 区间</span><b>${((causal.ci95?.[0] ?? 0) * 100).toFixed(2)} ~ ${((causal.ci95?.[1] ?? 0) * 100).toFixed(2)}pp</b></div>
    </div>
    <div class="divider"></div>
    <div class="kicker">转化漏斗</div>
    <div style="margin-top:10px">${funnel(report.funnel)}</div>
  </div>`;

  const lessonPanel = panel({
    title: '可复用结论',
    desc: 'Reflexion 写回长期记忆',
    tools: badge(`${report.lessons?.length ?? 0} LESSONS`, 'mint'),
    body: `<div class="lesson-list">${(report.lessons ?? [])
      .map(
        (lesson, index) => `<div class="lesson"><i>L${index + 1}</i><span>${esc(lesson)}</span></div>`
      )
      .join('')}${report.reflexion ? `<div class="detail-quote" style="margin-top:12px">${esc(report.reflexion)}</div>` : ''}</div>`
  });

  const nextPanel = panel({
    title: '下一场动作',
    desc: '把结论变成可执行清单',
    tools: badge(`${report.nextActions?.length ?? 0} ACTIONS`, 'amber'),
    body: `<div>${(report.nextActions ?? [])
      .map((action) => {
        const info = agentInfo(state, action.owner);
        return `<div class="next-action">
          <span class="owner" style="color:${safeColor(info.accent)}">${esc(info.glyph ?? '枢')}</span>
          <div class="next-action-body"><b>${esc(action.title)}</b><span>${esc(info.cn)} · ${esc(action.impact)}</span></div>
        </div>`;
      })
      .join('')}</div>`,
    foot: `<span>复盘用时 ${esc(report.kpis?.reviewMinutes ?? 1.4)} min</span><span>写入情景记忆</span>`
  });

  const banditPanel = panel({
    title: '话术赌博机 · Thompson Sampling',
    desc: '上下文 = 直播阶段 · 均值 = Beta 后验',
    tools: badge(`${state.bandit.updates} UPDATES`, 'blue'),
    body: banditGrid(state),
    foot: `<span>高亮为该阶段当前最优臂</span><span>${esc(state.bandit.policy ?? '')}</span>`
  });

  const memoryPanel = panel({
    title: '情景记忆',
    desc: '同类场次的得失，进入本场决策',
    tools: badge(`图谱 ${state.memory.graph.nodes}/${state.memory.graph.edges}`, 'blue'),
    body: `<div class="memory-cases">${(state.memory.recentEpisodes ?? [])
      .slice(0, 4)
      .map(
        (episode) => `<div class="memory-case">
          <header><b>${esc(episode.title)}</b><span>${esc(episode.date ?? '')}</span></header>
          <p>${esc(episode.text)}</p>
          <div class="tag-row" style="margin-top:6px">${(episode.tags ?? []).slice(0, 3).map((item) => tag(item)).join('')}</div>
        </div>`
      )
      .join('')}</div>`
  });

  return `${head}${banner}${hero}${kpiStrip}
    <div class="split-main">${dagPanel}<div>${attDetail}</div></div>
    <div class="grid-2" style="margin-top:16px">${lessonPanel}${nextPanel}</div>
    <div class="grid-2" style="margin-top:16px">${banditPanel}${memoryPanel}</div>`;
}

function toolCard(state, tool) {
  const risk = riskMeta(tool.riskLevel);
  return `<article class="tool-card ${tool.source === 'hotplug' ? 'custom' : ''}" data-act="tool" data-tool="${esc(
    tool.name
  )}">
    <div class="tool-card-top">
      <span class="tool-name">${esc(tool.name).replace(/\./g, '.<wbr>')}</span>
      <span style="display:flex;gap:4px;align-items:center">${badge(risk.label, risk.tone)}${
        tool.requiresApproval ? `<span title="需要共识审批">${icon('lock', 12)}</span>` : ''
      }</span>
    </div>
    <p class="tool-desc">${esc(tool.description)}</p>
    <div class="tool-meta">
      <span>${esc(tool.category)} · ${esc(tool.source)}</span>
      <span>${tool.stats.calls} calls · ${tool.avgMs}ms</span>
    </div>
  </article>`;
}

function hotplugForm() {
  return `<form class="hotplug-form" data-form="hotplug">
    <div class="field"><label>工具名 · 反向域名</label><input class="input" name="name" data-keep="hotplug-name" placeholder="market.compare" autocomplete="off" /></div>
    <div class="field"><label>分类</label><input class="input" name="category" data-keep="hotplug-category" value="扩展" /></div>
    <div class="field"><label>处理器</label><select class="select" name="handlerType" data-keep="hotplug-handler">
      <option value="market_compare">market_compare · 竞品比价</option>
      <option value="audience_weather">audience_weather · 人群活跃</option>
      <option value="margin_calc">margin_calc · 毛利测算</option>
    </select></div>
    <div class="field"><label>风险级别</label><select class="select" name="riskLevel" data-keep="hotplug-risk">
      <option value="low">low · 只读</option>
      <option value="medium">medium · 建议审批</option>
      <option value="high">high · 高风险</option>
    </select></div>
    <div class="field span-2"><label>描述</label><input class="input" name="description" data-keep="hotplug-description" placeholder="接入外部竞品价格，用于讲解中的可比锚点" /></div>
    <button class="btn primary" type="submit" data-act="hotplug-submit">${icon('plus', 14)}挂载工具</button>
    <div class="chip-row" style="align-items:center">
      <button class="chip" type="button" data-act="hotplug-preset" data-preset="market_compare">示例 · 比价</button>
      <button class="chip" type="button" data-act="hotplug-preset" data-preset="audience_weather">示例 · 活跃度</button>
      <button class="chip" type="button" data-act="hotplug-preset" data-preset="margin_calc">示例 · 毛利</button>
    </div>
  </form>`;
}

function protocolView(state, ui) {
  const head = pageHead({
    eyebrow: '工具与协议',
    title: '工具自描述，消息有信封',
    desc: 'MCP 注册表支持运行时热插拔；A2A 信封带 trace_id 与 performative；黑板按版本收敛共享状态。',
    actions: [
      actionButton('查看总线', 'navigate', { iconName: 'message', size: 'sm', data: { view: 'decisions' } }),
      actionButton('系统验收', 'navigate', { iconName: 'shield', size: 'sm', data: { view: 'system' } })
    ].join('')
  });

  const count = state.tools.length;
  const custom = state.tools.filter((tool) => tool.source === 'hotplug').length;
  const stats = `<div class="grid-4">
    <div class="live-metric"><span>MCP 工具</span><strong>${count}</strong><em>${custom} 个热插拔</em></div>
    <div class="live-metric"><span>总线消息</span><strong>${fmtNum(state.busStats.sent)}</strong><em>${state.busStats.rerouted} 次改投</em></div>
    <div class="live-metric"><span>黑板版本</span><strong>v${state.blackboard.version}</strong><em>单一事实源</em></div>
    <div class="live-metric"><span>共识记录</span><strong>${state.consensusHistory.length}</strong><em>阈值 2.4</em></div>
  </div>`;

  const toolPanel = panel({
    title: 'MCP 工具注册表',
    desc: '点击工具查看 schema、统计并直接调用',
    tools: badge(`${count} TOOLS`, 'mint'),
    body: `<div class="tool-grid">${state.tools.map((tool) => toolCard(state, tool)).join('')}</div>`,
    foot: `<span>高风险工具必须携带有效审批 ID</span><span>${custom} custom</span>`
  });

  const hotplugPanel = panel({
    title: '运行时热插拔',
    desc: '不重启智能体，直接扩展能力边界',
    tools: badge('MCP 动态挂载', 'violet'),
    body: `<div class="hotplug-box" style="grid-template-columns:1fr">
      ${hotplugForm()}
      <div class="detail-quote">工具注册后立即出现在注册表，可被任何 Actor 调用。卸载只允许针对 hotplug 工具，内置能力不可移除。</div>
    </div>`
  });

  const blackboard = state.blackboard;
  const bbKeys = [
    'stage',
    'viewers',
    'gmv',
    'orders',
    'interactionRate',
    'cvr',
    'sentiment',
    'riskLevel',
    'latencyP99',
    'currentProduct',
    'couponActive',
    'version'
  ];
  const bbPanel = panel({
    title: '版本化黑板',
    desc: '所有 Agent 共享的单一事实源',
    tools: badge(`v${blackboard.version}`, 'mint'),
    body: `<div class="blackboard-grid">${bbKeys
      .map((key) => {
        let value = blackboard[key];
        if (key === 'gmv') value = fmtMoney(value);
        else if (key === 'cvr' || key === 'interactionRate') value = fmtPct(value, 2);
        else if (key === 'sentiment') value = Number(value).toFixed(2);
        else if (key === 'latencyP99') value = fmtMs(value);
        else if (key === 'couponActive') value = value ? '已激活' : '未激活';
        else if (key === 'version') value = `v${value}`;
        else if (key === 'currentProduct') value = value ?? '—';
        return `<div class="bb-item"><span>${esc(DIMENSION_LABEL[key] ?? key)}</span><b>${esc(value)}</b></div>`;
      })
      .join('')}</div>`,
    foot: `<span>最后更新 ${esc(fmtDateTime(blackboard.updatedAt))}</span><span>${esc(blackboard.sessionId ?? '—')}</span>`
  });

  const consensus = state.consensus;
  const consensusPanel = panel({
    title: '共识表决',
    desc: '权重来自角色职责，不来自实例副本',
    tools: consensus ? badge(`${consensus.weight ?? 0} / ${consensus.threshold ?? 2.4}`, consensus.approved ? 'mint' : 'danger') : badge('无投票'),
    body: consensus
      ? `<div class="consensus-box">
          <div class="consensus-head"><strong>${consensus.vetoed ? '合规否决' : consensus.approved ? '提案通过' : '提案冻结'}</strong><span class="consensus-weight">${consensus.weight ?? 0} / ${consensus.threshold ?? 2.4}</span></div>
          <div class="ballot-list">${(consensus.ballots ?? [])
            .map(
              (ballot) => `<div class="ballot"><b>${esc(agentInfo(state, ballot.agent).cn)}</b><span class="${
                ballot.approve ? 'vote-yes' : 'vote-no'
              }">${ballot.approve ? '赞成' : '反对'}</span><em>w ${ballot.weight}</em></div>`
            )
            .join('') || '<span class="mono dim" style="font-size:10.5px">合规哨兵直接否决</span>'}</div>
          <div class="mono dim" style="margin-top:8px;font-size:10px">${esc(consensus.approvalId ?? '')}</div>
        </div>`
      : empty('暂无共识', '触发发券 / 舆情 / 改价后生成。', 'shield')
  });

  const historyPanel = panel({
    title: '共识历史',
    desc: '最近表决结果',
    body: `<div class="consensus-history">${
      state.consensusHistory.length
        ? state.consensusHistory
            .slice(0, 6)
            .map(
              (item) => `<div class="consensus-history-row">
                <span class="mono dim" style="font-size:10px">${esc(fmtDateTime(item.at))}</span>
                <b>${esc(item.proposalId)}</b>
                ${badge(item.approved ? '通过' : item.vetoed ? '否决' : '冻结', item.approved ? 'mint' : 'danger')}
                <span class="mono dim" style="font-size:10px">${item.weight}/${item.threshold}</span>
              </div>`
            )
            .join('')
        : empty('暂无表决历史', '', 'clock')
    }</div>`
  });

  const messages = state.messages.slice(0, 18);
  const messagePanel = panel({
    title: 'A2A 信封流',
    desc: '最近 18 条消息 · trace_id 强制',
    tools: badge(`${state.busStats.sent} 已发送 · ${state.busStats.broadcast} 广播`, 'blue'),
    body: `<div class="table-wrap"><table class="data-table message-table">
      <thead><tr><th>时间</th><th>Performative</th><th>发送方</th><th>接收方</th><th>摘要</th><th>Trace</th></tr></thead>
      <tbody>${messages
        .map(
          (env) => `<tr>
            <td class="mono">${esc(env.createdAt ? fmtTime(env.createdAt) : '—')}</td>
            <td><span class="perf ${esc(env.performative)}">${esc(env.performative)}</span></td>
            <td>${esc(agentInfo(state, env.sender).cn)}</td>
            <td>${esc(env.receiver === '*' || !env.receiver ? '全体' : agentInfo(state, env.receiver).cn)}</td>
            <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(
              String(envSummary(env)).slice(0, 60)
            )}</td>
            <td class="mono">${esc(shortId(env.traceId, 15))}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table></div>`,
    flush: true,
    foot: `<span>广播 ${state.busStats.broadcast} · 改投 ${state.busStats.rerouted} · 丢弃 ${state.busStats.dropped}</span><span>${state.busStats.logSize} / 600 log</span>`
  });

  return `${head}${stats}
    <div class="split-main" style="margin-top:16px">${toolPanel}${hotplugPanel}</div>
    <div class="grid-2" style="margin-top:16px">${bbPanel}${consensusPanel}</div>
    <div style="margin-top:16px">${messagePanel}</div>
    <div style="margin-top:16px">${historyPanel}</div>`;
}

function probeRow(probe) {
  return `<div class="probe-row">
    <span class="probe-icon ${probe.status}">${probe.status === 'pass' ? '✓' : probe.status === 'warn' ? '!' : '×'}</span>
    <div class="probe-name"><b>${esc(probe.title)}</b><small>${esc(probe.target)}</small></div>
    <span class="probe-metric">${esc(probe.metric)}</span>
    <span class="probe-detail" title="${esc(probe.detail)}">${esc(probe.detail)}</span>
    <span class="probe-duration">${fmtMs(probe.durationMs)}</span>
  </div>`;
}

function systemView(state, ui) {
  const report = ui.acceptance;
  const loading = ui.acceptanceLoading;
  const head = pageHead({
    eyebrow: '系统验收',
    title: '不是演示完就算，要能验出来',
    desc: '20 项探针覆盖架构、决策、协同、安全、稳定性与业务效果；不可现场验证的项目如实标注。',
    actions: [
      actionButton(loading ? '验收运行中' : '重新运行验收', 'acceptance', {
        iconName: 'gauge',
        tone: 'primary',
        size: 'sm',
        data: { force: '1' }
      }),
      actionButton('重置演示', 'reset', { iconName: 'refresh', tone: 'danger', size: 'sm' })
    ].join('')
  });

  const score = report?.score ?? 0;
  const summary = report?.summary ?? { total: 20, pass: 0, warn: 0, fail: 0, passRate: 0 };
  const acceptanceHero = `<section class="acceptance-hero reveal">
    <div class="score-ring" style="--score:${score}">
      <div class="score-inner">
        <strong>${report ? score : '—'}</strong>
        <span>验收得分</span>
        <em>${esc(report?.verdict ?? (loading ? '正在运行' : '等待运行'))}</em>
      </div>
    </div>
    <div class="acceptance-copy">
      <div class="kicker">独立运行时 · 本地确定性内核实测</div>
      <h2>${esc(report ? report.verdict : '运行一次完整验收')}</h2>
      <p>${esc(
        report
          ? `本次验收耗时 ${fmtMs(report.durationMs)}，使用独立运行时复现全链路；业务指标为仿真数据，延迟为本机实测。`
          : '点击右上角运行验收。探针会在隔离运行时中复现方案、开播、舆情、发券、改价、复盘、压测与容灾。'
      )}</p>
      <div class="acceptance-counters">
        <div class="counter"><strong>${summary.total}</strong><span>探针总数</span></div>
        <div class="counter pass"><strong>${summary.pass}</strong><span>通过</span></div>
        <div class="counter warn"><strong>${summary.warn}</strong><span>待现场验证</span></div>
        <div class="counter fail"><strong>${summary.fail}</strong><span>失败</span></div>
        <div class="counter"><strong>${summary.passRate}%</strong><span>通过率</span></div>
      </div>
      <div class="tag-row" style="margin-top:12px">
        ${badge('20 PROBES', 'mint')}${badge('72H · 待现场', 'amber')}${badge('业务提升 · 待灰度', 'amber')}
        ${report ? badge(`MEASURED P99 ${fmtMs(report.measured?.p99 ?? 0)}`, 'blue') : ''}
      </div>
    </div>
  </section>`;

  const groups = report?.groups ?? [];
  const probePanel = panel({
    title: '验收探针',
    desc: loading ? '正在隔离运行时中执行…' : '证据逐条保留，失败不会被隐藏',
    tools: report ? badge(report.id, 'blue') : badge('NOT RUN', 'amber'),
    body: report
      ? groups
          .map(
            (group) => `<div class="probe-group">
              <div class="probe-group-head">
                <h3>${esc(group.name)}</h3>
                <span class="group-line"></span>
                <span class="tag">通过 ${group.pass}</span>
                <span class="tag">WARN ${group.warn}</span>
                ${group.fail ? `<span class="tag" style="color:var(--danger)">失败 ${group.fail}</span>` : ''}
              </div>
              ${report.probes
                .filter((probe) => probe.group === group.name)
                .map((probe) => probeRow(probe))
                .join('')}
            </div>`
          )
          .join('')
      : empty(loading ? '正在运行验收…' : '尚未运行验收', '运行后会显示 20 项探针的证据链。', 'shield'),
    cls: loading ? 'reveal' : ''
  });

  const load = ui.stressResult ?? state.loadTest;
  const stress = `<div class="stress-layout">
    <div>
      ${panel({
        title: '本机意图链路压测',
        desc: '动态批处理 · 背压队列 48 · 目标 P99 ≤ 500ms',
        tools: `<div class="chip-row">
          <button class="chip" data-act="stress" data-events="400">400</button>
          <button class="chip" data-act="stress" data-events="800">800</button>
          <button class="chip" data-act="stress" data-events="2000">2000</button>
        </div>`,
        body: `<div class="stress-result">
          <div class="stress-stat"><span>P50</span><strong>${load ? `${load.p50}ms` : '—'}</strong></div>
          <div class="stress-stat"><span>P95</span><strong>${load ? `${load.p95}ms` : '—'}</strong></div>
          <div class="stress-stat"><span>P99</span><strong>${load ? `${load.p99}ms` : '—'}</strong></div>
          <div class="stress-stat"><span>吞吐</span><strong>${load ? `${fmtNum(load.throughput)}/s` : '—'}</strong></div>
          <div class="stress-stat"><span>丢弃</span><strong>${load ? load.dropped : '—'}</strong></div>
          <div class="stress-stat"><span>批次</span><strong>${load ? load.batches : '—'}</strong></div>
        </div>
        ${
          load
            ? `<div class="detail-quote" style="font-size:9.5px">${esc(load.mode)} · ${load.events} 条 · 墙钟 ${fmtMs(
                load.wallMs
              )} · ${load.passed ? '达到目标' : '未达目标，需扩容'}</div>`
            : `<div class="mono dim" style="font-size:10.5px">选择事件规模运行。压测只覆盖意图分类与流式调度，不包含外部模型网络时延。</div>`
        }
        <div class="table-wrap" style="margin-top:12px">${
          state.stressHistory?.length
            ? `<table class="data-table"><thead><tr><th>时间</th><th>事件</th><th>P99</th><th>吞吐</th><th>结果</th></tr></thead><tbody>${state.stressHistory
                .slice(0, 5)
                .map(
                  (item) => `<tr><td class="mono">${esc(fmtTime(item.at))}</td><td>${item.events}</td><td class="mono">${item.p99}ms</td><td class="mono">${fmtNum(
                    item.throughput
                  )}/s</td><td>${badge(item.passed ? '通过' : '未达标', item.passed ? 'mint' : 'danger')}</td></tr>`
                )
                .join('')}</tbody></table>`
            : ''
        }</div>`
      })}
    </div>
    <div>
      ${panel({
        title: '故障注入 · 热备接管',
        desc: '主实例下线，消息按 logicalRole 改投给活跃副本',
        body: `<div class="fault-grid">${state.agents
          .filter((agent) => !agent.replicaOf)
          .map(
            (agent) => `<div class="fault-card">
              <div class="fault-card-head">${agentOrb(state, agent.id, 22)}<b>${esc(agent.name)}</b>
                <span class="agent-status ${agent.status}" style="margin-left:auto">${agent.status.toUpperCase()}</span>
              </div>
              <p>${esc(agent.title)} · 当前 ${agent.status === 'active' ? '在线' : agent.status === 'offline' ? '已下线' : '热备'}${agent.mailbox ? ` · 邮箱 ${agent.mailbox}` : ''}</p>
              <div class="chip-row">
                <button class="chip" data-act="fault" data-agent="${esc(agent.id)}" data-mode="offline">下线</button>
                <button class="chip" data-act="fault" data-agent="${esc(agent.id)}" data-mode="restore">恢复</button>
              </div>
            </div>`
          )
          .join('')}</div>
        <div class="divider"></div>
        <div class="kicker">人工介入 · ${state.humanQueue.length}</div>
        <div style="margin-top:9px">${
          state.humanQueue.length
            ? state.humanQueue
                .slice(0, 3)
                .map(
                  (ticket) => `<div class="memory-line">${icon('users', 13)}<span>${esc(
                    ticket.reason
                  )}</span><b>${esc(ticket.id)}</b></div>`
                )
                .join('')
            : '<div class="mono dim" style="font-size:10.5px">没有待人工处理的工单。</div>'
        }</div>`
      })}
    </div>
  </div>`;

  const layers = [
    ['接入层', '弹幕流 / SSE / 指令台', '动态批处理、暂停恢复、人工注入与所有 UI 动作的统一入口。'],
    ['协议层', 'A2A 信封 / 合同网 / 黑板', 'trace_id 强制，消息可按 logicalRole 改投；黑板按版本收敛共享事实。'],
    ['认知层', 'Plan-Execute / ReAct / Reflexion', '策选做计划，场控实时反应，观澜复盘并把结论写回记忆。'],
    ['工具层', 'MCP 注册表 / 风险分级 / 审批', '18+ 工具自描述；high / critical 动作必须携带共识审批。'],
    ['复盘层', '记忆 / 因果 / 赌博机 / 验收', 'ATT 与置信区间、Thompson Sampling、20 项独立验收探针。']
  ];
  const arch = panel({
    title: '五层架构',
    desc: '每一层都有可观察的运行证据',
    body: `<div class="arch-stack">${layers
      .map(
        ([name, stack, desc], index) => `<div class="arch-layer">
          <span class="arch-index">0${index + 1}</span>
          <b>${esc(name)}</b>
          <span><strong style="color:var(--text-soft);font-weight:500">${esc(stack)}</strong><br/>${esc(desc)}</span>
        </div>`
      )
      .join('')}</div>`
  });

  const runtime = panel({
    title: '运行环境',
    desc: '本地确定性内核，零外部依赖',
    tools: badge('本地', 'mint'),
    body: `<div class="runtime-list">
      ${[
        ['平台版本', `${state.meta.name} ${state.meta.version}`],
        ['运行模式', state.meta.mode],
        ['认知内核', state.meta.llm],
        ['架构', state.meta.architecture],
        ['已运行', `${fmtDuration(state.meta.uptimeSec)}`],
        ['自动仿真', state.meta.autoSimulate ? '开启' : '关闭'],
        ['Node', report?.environment?.node ?? '运行时可见于验收报告'],
        ['数据说明', '业务指标为仿真；时延为本机意图链路实测']
      ]
        .map(([key, value]) => `<div class="runtime-row"><span>${esc(key)}</span><b>${esc(value)}</b></div>`)
        .join('')}
    </div>`,
    foot: `<span>${esc(report?.environment?.dataLabel ?? '演示数据已在界面持续标注')}</span>`
  });

  return `${head}${acceptanceHero}${probePanel}
    <div style="margin-top:16px">${stress}</div>
    <div class="split-even" style="margin-top:16px">${arch}${runtime}</div>`;
}

export function renderView(viewId, state, ui) {
  if (!state) return '';
  const body = (() => {
    switch (viewId) {
      case 'agents':
        return agentsView(state, ui);
      case 'live':
        return liveView(state, ui);
      case 'decisions':
        return decisionsView(state, ui);
      case 'review':
        return reviewView(state, ui);
      case 'protocol':
        return protocolView(state, ui);
      case 'system':
        return systemView(state, ui);
      default:
        return overviewView(state, ui);
    }
  })();
  return `${flowBar(state)}${body}`;
}

function chatBlock(block, state) {
  if (!block || !block.type) return '';
  if (block.type === 'kpi') {
    return `<div class="chat-kpis">${(block.items ?? [])
      .map(
        (item) => `<div class="chat-kpi"><span>${esc(item.label)}</span><strong class="${
          item.tone === 'danger' ? 'danger' : item.tone === 'ok' ? 'mint' : item.tone === 'warn' ? 'amber' : ''
        }">${esc(item.value)}</strong></div>`
      )
      .join('')}</div>`;
  }
  if (block.type === 'list') {
    return `${block.title ? `<div class="kicker" style="margin-top:10px">${esc(block.title)}</div>` : ''}
      <ul class="chat-list">${(block.items ?? [])
        .map(
          (item) => `<li><b>${esc(item.title)}<em>${esc(item.badge ?? '')}</em></b>${
            item.desc ? `<small>${esc(item.desc)}</small>` : ''
          }</li>`
        )
        .join('')}</ul>`;
  }
  if (block.type === 'decision') {
    const decision = block.decision;
    return `<div class="chat-decision" data-act="decision" data-decision="${esc(decision.id)}">
      <small><span>${esc(decision.id)}</span><span>${esc(riskMeta(decision.risk).text)}</span></small>
      <p>${esc(decision.action)}</p>
    </div>`;
  }
  if (block.type === 'notice') {
    return `<div class="chat-notice">${esc(block.text)}</div>`;
  }
  return '';
}

export function chatHtml(messages, state) {
  return (messages ?? [])
    .map((message) => {
      const assistant = message.role === 'assistant';
      return `<div class="chat-row ${assistant ? '' : 'user'}">
        <span class="chat-avatar">${assistant ? '枢' : '你'}</span>
        <div class="chat-body">
          <div class="chat-name">${
            assistant ? (message.mode === 'llm' ? '中枢 Copilot · 大模型' : '中枢 Copilot') : '操作员'
          } · ${esc(fmtTime(message.at))}</div>
          <div class="chat-bubble">${formatText(message.text)}
            ${(message.blocks ?? []).map((block) => chatBlock(block, state)).join('')}
            ${
              message.actions?.length
                ? `<div class="chat-actions">${message.actions
                    .map(
                      (action) =>
                        `<button class="chat-action" data-act="chat-action" data-kind="${esc(
                          action.kind
                        )}" data-message="${esc(action.payload?.message ?? '')}" data-path="${esc(
                          action.payload?.path ?? ''
                        )}" data-view="${esc(action.payload?.view ?? '')}">${esc(action.label)}</button>`
                    )
                    .join('')}</div>`
                : ''
            }
          </div>
        </div>
      </div>`;
    })
    .join('');
}

export function decisionDetailHtml(decision, state) {
  const info = agentInfo(state, decision.agent);
  const risk = riskMeta(decision.risk);
  const consensus = decision.consensus;
  const guardrail = decision.guardrail;
  return `<div class="detail-section">
    <div class="detail-label">DECISION</div>
    <div class="detail-quote">${esc(decision.action)}</div>
    <p class="detail-copy" style="margin-top:9px">${esc(decision.trigger)}</p>
  </div>
  <div class="detail-section">
    <div class="detail-label">RATIONALE</div>
    <p class="detail-copy">${esc(decision.reasoning)}</p>
  </div>
  <div class="detail-section">
    <div class="detail-label">EVIDENCE · ${decision.evidence?.length ?? 0}</div>
    <ul class="evidence-list">${(decision.evidence ?? [])
      .map((item) => `<li>${esc(item)}</li>`)
      .join('')}</ul>
  </div>
  ${
    consensus
      ? `<div class="detail-section">
          <div class="detail-label">CONSENSUS</div>
          <div class="consensus-box">
            <div class="consensus-head"><strong>${
              consensus.vetoed ? '合规否决' : consensus.approved ? '已通过' : '未通过'
            }</strong><span class="consensus-weight">${consensus.weight ?? 0} / ${consensus.threshold ?? 2.4}</span></div>
            <div class="ballot-list">${(consensus.ballots ?? [])
              .map(
                (ballot) => `<div class="ballot"><b>${esc(agentInfo(state, ballot.agent).cn)}</b>
                  <span class="${ballot.approve ? 'vote-yes' : 'vote-no'}">${ballot.approve ? '赞成' : '反对'}</span>
                  <em>w ${ballot.weight}</em></div>`
              )
              .join('')}</div>
            ${
              consensus.veto
                ? `<div class="mono" style="margin-top:8px;font-size:10.5px;color:var(--danger)">${esc(
                    consensus.veto.reason
                  )}</div>`
                : ''
            }
          </div>
        </div>`
      : ''
  }
  ${
    guardrail
      ? `<div class="detail-section">
          <div class="detail-label">GUARDRAIL</div>
          <div class="detail-copy">命中 ${guardrail.violations?.length ?? 0} 处 · ${
            guardrail.pass ? '通过' : '已强制改写'
          }</div>
          <ul class="evidence-list" style="margin-top:8px">${(guardrail.violations ?? [])
            .map((violation) => `<li>${esc(violation.message ?? violation.term)}</li>`)
            .join('')}</ul>
        </div>`
      : ''
  }
  ${
    decision.alternatives?.length
      ? `<div class="detail-section">
          <div class="detail-label">ALTERNATIVES</div>
          <div class="tag-row">${decision.alternatives.map((item) => tag(item)).join('')}</div>
        </div>`
      : ''
  }
  <div class="detail-section">
    <div class="detail-label">METADATA</div>
    <div class="detail-kvs">
      ${[
        ['决策 ID', decision.id],
        ['智能体', `${info.cn} · ${info.role}`],
        ['风险', `${risk.text} / ${decision.risk}`],
        ['置信度', `${(Number(decision.confidence) * 100).toFixed(0)}%`],
        ['延迟', fmtMs(decision.latencyMs)],
        ['状态', statusText(decision.status)],
        ['场次', decision.sessionId],
        ['时间', fmtDateTime(decision.createdAt)]
      ]
        .map(
          ([key, value]) =>
            `<div class="detail-kv"><span>${esc(key)}</span><b>${esc(value ?? '—')}</b></div>`
        )
        .join('')}
    </div>
  </div>
  <div class="detail-section">
    <div class="detail-label">TRACE</div>
    <button class="trace-tag" data-act="trace" data-trace="${esc(decision.traceId)}">${icon(
      'flow',
      11
    )}${esc(decision.traceId)}</button>
  </div>`;
}

export function agentDetailHtml(agent, state) {
  const tools = (agent.tools ?? [])
    .map((name) => state.tools.find((tool) => tool.name === name)?.name ?? name)
    .map((name) => tag(name))
    .join('');
  return `<div class="detail-section">
    <div class="detail-label">PROFILE</div>
    <p class="detail-copy">${esc(agent.description)}</p>
    <div class="tag-row" style="margin-top:9px">${badge(agent.cognition, 'blue')}${badge(
      `WEIGHT ${agent.weight}`,
      'mint'
    )}${badge(agent.status.toUpperCase(), agent.status === 'active' ? 'mint' : agent.status === 'standby' ? '' : 'danger')}${
      agent.replicaOf ? badge(`REPLICA OF ${agent.replicaOf}`, 'violet') : ''
    }</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">CAPABILITIES</div>
    <div class="detail-kvs">${Object.entries(agent.capabilities ?? {})
      .map(
        ([key, value]) =>
          `<div class="detail-kv"><span>${esc(CAP_LABEL[key] ?? key)}</span><b>${Math.round(value * 100)} / 100</b></div>`
      )
      .join('')}</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">STATE</div>
    <div class="detail-kvs">
      ${[
        ['实例 ID', agent.id],
        ['逻辑角色', agent.logicalRole],
        ['当前任务', agent.currentTask ?? '空闲'],
        ['最近动作', agent.lastAction],
        ['邮箱', `${agent.mailbox} 条待处理`],
        ['处理 / 收件', `${agent.handled} / ${agent.received}`],
        ['负载', `${Math.round((agent.load ?? 0) * 100)}%`],
        ['可靠性', agent.reliability]
      ]
        .map(
          ([key, value]) =>
            `<div class="detail-kv"><span>${esc(key)}</span><b>${esc(value ?? '—')}</b></div>`
        )
        .join('')}
    </div>
  </div>
  <div class="detail-section">
    <div class="detail-label">TOOLS</div>
    <div class="tag-row">${tools || '<span class="dim">无绑定工具</span>'}</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">RECENT ENVELOPES</div>
    <div class="trace-rail">${(agent.recentEnvelopes ?? [])
      .map(
        (env) => `<div class="trace-mini" style="cursor:default">
          <div class="trace-mini-head"><b>${esc(env.performative)}</b><span>${esc(fmtTime(env.at))}</span></div>
          <p>${esc(agentInfo(state, env.from).cn)} → ${esc(agent.name)} · ${esc(shortId(env.traceId, 18))}</p>
        </div>`
      )
      .join('') || '<span class="dim" style="font-size:9px">暂无信封</span>'}</div>
  </div>
  ${
    (agent.workingMemory ?? []).length
      ? `<div class="detail-section">
          <div class="detail-label">WORKING MEMORY</div>
          <ul class="evidence-list">${agent.workingMemory
            .map((item) => `<li>${esc(item.summary ?? item.kind ?? JSON.stringify(item))}</li>`)
            .join('')}</ul>
        </div>`
      : ''
  }`;
}

function sampleArgs(tool) {
  const props = tool.parameters?.properties ?? {};
  const args = {};
  for (const [key, schema] of Object.entries(props)) {
    if (schema.default != null) {
      args[key] = schema.default;
    } else if (schema.type === 'number') {
      args[key] = 1;
    } else if (schema.type === 'boolean') {
      args[key] = false;
    } else if (schema.type === 'array') {
      args[key] = [];
    } else if (key === 'productId') {
      args[key] = 'P-01';
    } else if (key === 'approvalId') {
      args[key] = '';
    } else if (schema.type === 'string') {
      args[key] = '示例';
    }
  }
  return JSON.stringify(args, null, 2);
}

export function toolDetailHtml(tool, state) {
  const risk = riskMeta(tool.riskLevel);
  const props = Object.entries(tool.parameters?.properties ?? {});
  return `<div class="detail-section">
    <div class="detail-label">TOOL</div>
    <div class="detail-quote">${esc(tool.description)}</div>
    <div class="tag-row" style="margin-top:9px">${badge(risk.text, risk.tone)}${badge(
      tool.category,
      'blue'
    )}${badge(tool.source, tool.source === 'hotplug' ? 'violet' : '')}${
      tool.requiresApproval ? badge('需审批', 'danger') : badge('免审批', 'mint')
    }</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">SCHEMA · ${props.length} FIELDS</div>
    ${
      props.length
        ? `<div class="detail-kvs">${props
            .map(([key, schema]) => {
              const required = tool.parameters?.required?.includes(key);
              return `<div class="detail-kv"><span>${esc(key)}${required ? ' *' : ''}</span><b>${esc(
                `${schema.type ?? 'any'} · ${schema.description ?? ''}`
              )}</b></div>`;
            })
            .join('')}</div>`
        : '<div class="mono dim" style="font-size:10.5px">无参工具</div>'
    }
  </div>
  <div class="detail-section">
    <div class="detail-label">CALL</div>
    <div class="field">
      <label>JSON 参数</label>
      <textarea class="textarea" data-keep="tool-args" name="args">${esc(sampleArgs(tool))}</textarea>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
      <button class="btn primary sm" data-act="tool-call" data-tool="${esc(tool.name)}">${icon('terminal', 13)}调用工具</button>
      ${
        tool.source === 'hotplug'
          ? `<button class="btn danger sm" data-act="tool-remove" data-tool="${esc(tool.name)}">${icon(
              'trash',
              13
            )}卸载</button>`
          : ''
      }
      <span class="mono dim" style="font-size:10px;margin-left:auto">${tool.stats.calls} calls · ${tool.stats.errors} errors</span>
    </div>
    ${
      tool.requiresApproval
        ? `<div class="chat-notice" style="margin-top:10px">高风险工具需要有效共识审批 ID。直接调用会被注册表拒绝，这是预期的安全行为。</div>`
        : ''
    }
  </div>
  <div class="detail-section">
    <div class="detail-label">RESULT</div>
    <div id="tool-result" class="mono dim" style="font-size:10.5px;white-space:pre-wrap;word-break:break-word">尚未调用</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">STATS</div>
    <div class="detail-kvs">
      ${[
        ['版本', tool.version],
        ['来源', tool.source],
        ['调用次数', tool.stats.calls],
        ['错误', tool.stats.errors],
        ['平均耗时', `${tool.avgMs}ms`],
        ['最后调用', tool.stats.lastCalledAt ? fmtDateTime(tool.stats.lastCalledAt) : '—']
      ]
        .map(([key, value]) => `<div class="detail-kv"><span>${esc(key)}</span><b>${esc(value)}</b></div>`)
        .join('')}
    </div>
  </div>`;
}

export function traceDetailHtml(trace, state) {
  if (!trace) return empty('Trace 不存在', '', 'flow');
  return `<div class="detail-section">
    <div class="detail-label">TRACE</div>
    <div class="detail-quote">${esc(trace.name)}</div>
    <div class="tag-row" style="margin-top:9px">${badge(trace.status.toUpperCase(), trace.status === 'ok' ? 'mint' : trace.status === 'running' ? 'blue' : 'danger')}${badge(
      fmtMs(trace.durationMs),
      'blue'
    )}${badge(trace.meta?.mode ?? '—', '')}</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">WATERFALL · ${trace.spans?.length ?? 0} SPANS</div>
    ${waterfall(trace.spans ?? [])}
  </div>
  <div class="detail-section">
    <div class="detail-label">SPANS</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Span</th><th>Agent</th><th>耗时</th><th>状态</th></tr></thead>
      <tbody>${(trace.spans ?? [])
        .map(
          (span) => `<tr><td>${esc(span.name)}</td><td>${esc(agentInfo(state, span.agent).cn)}</td><td class="mono">${
            span.durationMs ?? '—'
          }ms</td><td>${badge(span.status, span.status === 'ok' ? 'mint' : span.status === 'error' ? 'danger' : 'blue')}</td></tr>`
        )
        .join('')}</tbody></table></div>
  </div>
  <div class="detail-section">
    <div class="detail-label">METADATA</div>
    <div class="detail-kvs">
      ${[
        ['Trace ID', trace.id],
        ['场次', trace.meta?.sessionId ?? '—'],
        ['开始', trace.startedAt ? fmtDateTime(trace.startedAt) : '—'],
        ['结束', trace.finishedAt ? fmtDateTime(trace.finishedAt) : '—'],
        ['总耗时', fmtMs(trace.durationMs)],
        ['状态', trace.status]
      ]
        .map(([key, value]) => `<div class="detail-kv"><span>${esc(key)}</span><b>${esc(value ?? '—')}</b></div>`)
        .join('')}
    </div>
  </div>`;
}

export function planDetailHtml(plan, state) {
  if (!plan) return empty('尚未生成方案', '先运行一次 Plan-Execute。', 'sparkles');
  return `<div class="detail-section">
    <div class="detail-label">方案 ${esc(plan.version)}</div>
    <div class="detail-quote">${esc(plan.narrative?.headline ?? plan.title)}</div>
    <p class="detail-copy" style="margin-top:9px">${esc(plan.narrative?.rationale ?? '')}</p>
  </div>
  <div class="detail-section">
    <div class="detail-label">商品清单</div>
    <div class="detail-kvs">${(plan.products ?? [])
      .map(
        (product) =>
          `<div class="detail-kv"><span>${esc(product.id)} · ${esc(product.category)}</span><b>${esc(
            product.name
          )} · ${fmtMoney(product.price)}</b></div>`
      )
      .join('')}</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">节奏排期</div>
    <div class="trace-rail">${(plan.segments ?? [])
      .map(
        (segment) => `<div class="trace-mini" style="cursor:default">
          <div class="trace-mini-head"><b>${esc(segment.label)}</b><span>${segment.start}–${segment.end} MIN</span></div>
          <p>${esc(segment.goal)}</p>
          <div class="trace-mini-stats"><span>${esc(segment.style)}</span><span>${esc(segment.context)}</span></div>
        </div>`
      )
      .join('')}</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">话术</div>
    <div class="trace-rail">${(plan.scripts ?? [])
      .map(
        (script) => `<div class="trace-mini" style="cursor:default">
          <div class="trace-mini-head"><b>${esc(script.productName)}</b><span>${esc(script.style)}</span></div>
          <p style="white-space:normal;line-height:1.6">${esc(script.text)}</p>
        </div>`
      )
      .join('')}</div>
  </div>
  <div class="detail-section">
    <div class="detail-label">情景记忆命中 · ${plan.memoryHits?.length ?? 0}</div>
    <ul class="evidence-list">${(plan.memoryHits ?? [])
      .map((hit) => `<li>${esc(hit.title ?? hit.text ?? hit.summary ?? '')}</li>`)
      .join('')}</ul>
  </div>`;
}
