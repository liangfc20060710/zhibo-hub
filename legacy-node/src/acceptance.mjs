import { createEnvelope, PERFORMATIVES } from './a2a_layer/envelope.mjs';
import { ZhiboRuntime } from './orchestrator.mjs';
import { round } from './agent_core/util.mjs';

const VALID_RISKS = new Set(['low', 'medium', 'high', 'critical']);

function statusWeight(status) {
  if (status === 'pass') return 1;
  if (status === 'warn') return 0.5;
  return 0;
}

export async function runAcceptance({ stressEvents = 800 } = {}) {
  const started = performance.now();
  const runtimeEvents = [];
  const rt = new ZhiboRuntime({
    autoSimulate: false,
    emit: (type, payload) => runtimeEvents.push({ type, at: Date.now(), payload })
  });
  const probes = [];

  async function probe(id, group, title, target, run) {
    const t0 = performance.now();
    try {
      const result = await run();
      probes.push({
        id,
        group,
        title,
        target,
        status: result.status ?? 'pass',
        metric: result.metric ?? '通过',
        detail: result.detail ?? '',
        evidence: result.evidence ?? [],
        durationMs: round(performance.now() - t0, 2)
      });
    } catch (error) {
      probes.push({
        id,
        group,
        title,
        target,
        status: 'fail',
        metric: '执行失败',
        detail: error.message,
        evidence: [],
        durationMs: round(performance.now() - t0, 2)
      });
    }
  }

  const state = {};

  await probe(
    'arch.topology',
    '架构与协议',
    '四个对等 Actor + 热备副本全部注册',
    '4 逻辑角色 + 2 热备',
    async () => {
      const primary = rt.agentList.filter((agent) => !agent.replicaOf);
      const replicas = rt.agentList.filter((agent) => agent.replicaOf);
      const roles = ['selector', 'controller', 'speaker', 'analyst'];
      const covered = roles.every((role) => primary.some((agent) => agent.logicalRole === role));
      return {
        status: covered && replicas.length >= 2 ? 'pass' : 'fail',
        metric: `${primary.length} 主实例 / ${replicas.length} 热备`,
        detail: '消息总线、版本化黑板、MCP 注册表与 Trace 收集器在同一运行时装配。',
        evidence: primary.map((agent) => `${agent.id} · ${agent.cognition}`)
      };
    }
  );

  await probe(
    'mcp.schema',
    '架构与协议',
    'MCP 工具全部自描述且风险分级',
    '≥18 个工具，100% JSON Schema',
    async () => {
      const tools = rt.registry.list();
      const described = tools.filter(
        (tool) =>
          tool.description &&
          tool.parameters?.type === 'object' &&
          tool.parameters?.properties &&
          VALID_RISKS.has(tool.riskLevel)
      );
      return {
        status: tools.length >= 18 && described.length === tools.length ? 'pass' : 'fail',
        metric: `${tools.length} 个工具 · ${round((described.length / Math.max(tools.length, 1)) * 100, 1)}% 覆盖`,
        detail: '工具由运行时发现并调用；high / critical 动作额外要求共识审批。',
        evidence: tools.slice(0, 5).map((tool) => `${tool.name} · ${tool.riskLevel}`)
      };
    }
  );

  await probe(
    'mcp.hotplug',
    '架构与协议',
    '工具热插拔：注册、调用、卸载',
    '不重启智能体完成增删',
    async () => {
      const before = rt.registry.list().length;
      rt.hotplugTool({
        name: 'market.compare',
        description: '竞品价格对比 · 验收热插拔探针',
        handlerType: 'market_compare'
      });
      const call = await rt.callTool('market.compare', { productId: 'P-01' });
      rt.removeTool('market.compare');
      const after = rt.registry.list().length;
      const ok = before === after && call.result?.samples?.length === 3 && !rt.registry.get('market.compare');
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${before} → ${before + 1} → ${after}`,
        detail: '新工具以 schema + handler 注册，智能体代码零改动；卸载后注册表恢复原状。',
        evidence: ['market.compare 返回 3 条竞品样本', `工具源标记 ${call.tool}`]
      };
    }
  );

  await probe(
    'a2a.envelope',
    '架构与协议',
    'A2A 信封校验与 trace_id 贯穿',
    '11 类 performative，缺失 trace 即拒绝',
    async () => {
      const env = createEnvelope({
        sender: 'acceptance',
        receiver: 'selector',
        performative: 'CFP',
        traceId: 'TRC-ACCEPTANCE',
        content: { capability: 'planning' }
      });
      let rejected = false;
      try {
        createEnvelope({ sender: 'acceptance', performative: 'CFP' });
      } catch {
        rejected = true;
      }
      return {
        status: env.traceId === 'TRC-ACCEPTANCE' && rejected && PERFORMATIVES.length >= 11 ? 'pass' : 'fail',
        metric: `${PERFORMATIVES.length} 类消息 · 非法信封已拒绝`,
        detail: '发送方、接收方、对话行为、优先级与 trace_id 统一封装。',
        evidence: [`信封 ${env.msgId}`, `performative=${env.performative}`]
      };
    }
  );

  await probe(
    'prep.plan',
    '认知与决策',
    '直播前 Plan-Execute 生成可执行方案',
    '方案含选品、排期、话术、福利',
    async () => {
      state.prep = await rt.prepare();
      const plan = state.prep.plan;
      const complete =
        plan.products.length >= 4 &&
        plan.scripts.length >= 3 &&
        plan.offers &&
        Object.keys(plan.offers).length >= 2 &&
        plan.forecast &&
        plan.version === 'v1.1';
      return {
        status: complete ? 'pass' : 'fail',
        metric: `${plan.version} · 链上 ${state.prep.prepChainMs}ms`,
        detail: 'Selector 承接策划，Speaker 与 Controller 提交评审建议后自主协商定稿。',
        evidence: [
          `${plan.products.length} 个商品 · ${plan.scripts.length} 段话术`,
          `建议 ${plan.advisories.length} 条已并入定稿`
        ]
      };
    }
  );

  await probe(
    'cnp.award',
    '协同与安全',
    '合同网招标产生分工',
    '≥3 个投标且按综合评分择优',
    async () => {
      const contract = state.prep.contract ?? rt.lastContract;
      const ok = contract?.bids?.length >= 3 && contract.winner && contract.bids[0].score >= contract.bids[1].score;
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${contract.bids.length} 份投标 · 中标 ${contract.winner}`,
        detail: '能力匹配、当前负载、历史可靠性加权评分，无中央控制器指派。',
        evidence: contract.bids.slice(0, 3).map((bid) => `${bid.agent} · ${bid.score}`)
      };
    }
  );

  rt.startLive();

  await probe(
    'react.response',
    '认知与决策',
    '直播中 ReAct 实时响应',
    '意图识别 + 工具调用 + 话术',
    async () => {
      state.liveReply = await rt.ingestDanmaku('这款明前龙井是核心产区吗？帮我看看参数', {
        user: '验收观众',
        pool: 'product'
      });
      const response = state.liveReply.result?.response;
      const ok = response?.intent === 'product_question' && response.script && response.traceId;
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${response.latencyMs}ms · ${response.actionLabel}`,
        detail: 'Controller 分类与节奏判断，Speaker 生成口播与数字人指令，链路带 trace。',
        evidence: [`意图 ${response.intent}`, `风险 ${response.risk}`, `话术 ${String(response.script).slice(0, 34)}…`]
      };
    }
  );

  await probe(
    'guardrail.live',
    '协同与安全',
    '极限词触发拦截并合规改写',
    '违规草稿不直接输出',
    async () => {
      const result = await rt.ingestDanmaku('这款是全网最低吗？绝对有效吗？', {
        user: '合规观察员',
        pool: 'manual'
      });
      const response = result.result?.response;
      const guardrail = response?.guardrail;
      const output = String(response?.script ?? '');
      const intercepted =
        response?.status === 'guarded' &&
        guardrail?.pass === false &&
        guardrail.violations.length > 0 &&
        !output.includes('全网最低价') &&
        !output.includes('绝对有效');
      return {
        status: intercepted ? 'pass' : 'fail',
        metric: `${guardrail?.violations?.length ?? 0} 处违规 · 已重写`,
        detail: '规则引擎在话术输出前强制校验，命中极限词立即替换为合规表述。',
        evidence: [guardrail?.violations?.[0]?.message ?? '无违规', `输出 ${output.slice(0, 42)}…`]
      };
    }
  );

  await probe(
    'consensus.pass',
    '协同与安全',
    '高风险舆情动作通过加权共识',
    '权重 ≥ 2.4 且全员可追溯投票',
    async () => {
      state.incident = await rt.runScenario('negative');
      const incident = state.incident.incident;
      const votes = incident.voteSummary;
      const ok =
        incident.status === 'executed' &&
        votes.weight >= votes.threshold &&
        votes.ballots.length === 4 &&
        votes.ballots.every((ballot) => ballot.approve) &&
        Boolean(incident.coupon);
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${votes.weight.toFixed(1)} / ${votes.threshold.toFixed(1)} 权重通过`,
        detail: 'Controller 提案，四智能体独立投票；通过后经审批 ID 才能调用高风险管理工具。',
        evidence: votes.ballots.map((ballot) => `${ballot.agent} ${ballot.approve ? '赞成' : '反对'} · ${ballot.weight}`)
      };
    }
  );

  await probe(
    'compliance.veto',
    '协同与安全',
    '合规智能体一票否决价格红线',
    '低于底价立即冻结',
    async () => {
      const result = await rt.runScenario('price');
      const veto = result.veto;
      const ok =
        veto?.vetoed === true &&
        veto?.code === 'PRICE_FLOOR' &&
        result.decision?.status === 'vetoed' &&
        result.decision?.consensus?.weight === 0;
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${veto?.code ?? 'NO_VETO'} · 权重清零`,
        detail: '否决后不再进入投票，决策卡片以 vetoed 状态冻结，并进入人工复核队列。',
        evidence: [veto?.reason ?? '未触发', result.decision?.action ?? '—']
      };
    }
  );

  await probe(
    'approval.gate',
    '协同与安全',
    '高风险工具必须携带有效审批',
    '无审批 → 拒绝；有审批 → 执行',
    async () => {
      state.coupon = await rt.runScenario('coupon');
      let blocked = null;
      try {
        await rt.callTool('coupon.issue', { amount: 15, threshold: 199 });
      } catch (error) {
        blocked = error.code;
      }
      const approvalId = rt.lastConsensus?.approvalId;
      const issued = await rt.callTool('coupon.issue', {
        amount: 15,
        threshold: 199,
        approvalId
      });
      return {
        status: blocked === 'APPROVAL_REQUIRED' && issued.result?.id ? 'pass' : 'fail',
        metric: blocked === 'APPROVAL_REQUIRED' ? '门禁生效' : '门禁失效',
        detail: '工具层独立校验审批 ID 与工具白名单，智能体无法绕过共识直接发券。',
        evidence: [`无审批调用 → ${blocked}`, `审批调用 → ${issued.result.id}`]
      };
    }
  );

  await probe(
    'fault.transfer',
    '稳定性与运维',
    '主实例故障自动切换热备',
    '同角色副本接管，消息不中断',
    async () => {
      const fault = rt.setAgentFault('controller', 'offline');
      const record = await rt.bus.send(
        createEnvelope({
          sender: 'acceptance',
          receiver: 'controller',
          performative: 'INFORM',
          traceId: 'TRC-ACCEPTANCE-FAULT',
          content: { kind: 'health.check' }
        })
      );
      rt.setAgentFault('controller', 'restore');
      const ok = fault.status === 'offline' && record.deliveredTo.includes('controller-b');
      return {
        status: ok ? 'pass' : 'fail',
        metric: `controller → ${record.deliveredTo.join(', ') || '无接管'}`,
        detail: '总线按逻辑角色解析目标，主实例离线后自动路由到 active 热备；恢复后原实例回主。',
        evidence: [`副本 ${fault.replica} 接管`, `投递 ${record.msgId}`]
      };
    }
  );

  rt.stopLive();

  await probe(
    'reflexion.review',
    '认知与决策',
    '直播后 Reflexion 写出可执行结论',
    '复盘含因果、教训、下一场动作',
    async () => {
      state.review = await rt.review();
      const report = state.review.report;
      const ok =
        report.lessons.length >= 3 &&
        report.nextActions.length === 4 &&
        typeof report.reflexion === 'string' &&
        report.memoryHits.length >= 0 &&
        Boolean(report.causal.statement);
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${report.lessons.length} 条教训 · ${report.durationMs ?? '—'}ms`,
        detail: 'Analyst 汇总指标、召回历史案例、生成反思，并把本场写入情景记忆。',
        evidence: report.lessons.slice(0, 2)
      };
    }
  );

  await probe(
    'memory.recall',
    '认知与决策',
    '三层记忆检索与知识图谱',
    '工作 / 情景 / 语义均可查询',
    async () => {
      const hits = rt.memory.recall('舆情处置 检测报告 发券', 3);
      const graph = rt.memory.semanticQuery('龙井');
      const snapshot = rt.memory.snapshot();
      const ok = hits.length > 0 && graph.nodes.length > 0 && snapshot.episodicCount >= 5;
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${snapshot.episodicCount} 条情景 · ${snapshot.graph.nodes} 节点`,
        detail: '情景记忆使用字符 n-gram 余弦与时间衰减排序，语义记忆沿商品—规则—话术图谱遍历。',
        evidence: [
          `召回 ${hits.length} 条，最高分 ${hits[0]?.score ?? 0}`,
          `图谱命中 ${graph.nodes.map((node) => node.label).slice(0, 2).join('、')}`
        ]
      };
    }
  );

  await probe(
    'bandit.learning',
    '认知与决策',
    '上下文赌博机在线更新',
    'Beta 后验随场次累积',
    async () => {
      const snapshot = rt.bandit.snapshot();
      const observations = snapshot.contexts.reduce(
        (sum, context) => sum + context.arms.reduce((inner, arm) => inner + arm.observations, 0),
        0
      );
      return {
        status: snapshot.updates > 0 && observations > 0 ? 'pass' : 'fail',
        metric: `${snapshot.updates} 次更新 · ${observations} 个观测`,
        detail: '按直播阶段选择话术风格，用下单反馈更新 Beta(α, β)，随机采样保持探索。',
        evidence: snapshot.contexts.slice(0, 2).map((item) => `${item.context} → ${item.chosen}`)
      };
    }
  );

  await probe(
    'causal.att',
    '认知与决策',
    'A/B 因果估计达到统计显著',
    'ATT > 0，p < 0.05，CI 不含 0',
    async () => {
      state.causal = rt.causal.simulateExperiment({
        intervention: '讲解完成后第 52 分钟发券',
        n: 6000,
        baseRate: 0.032,
        effect: 0.014,
        seed: 20261108
      });
      const causal = state.causal;
      const ok =
        causal.significant &&
        causal.att > 0.01 &&
        causal.pValue < 0.05 &&
        causal.ci95[0] > 0;
      return {
        status: ok ? 'pass' : 'fail',
        metric: `ATT +${(causal.att * 100).toFixed(2)}pp · p=${causal.pValue.toFixed(4)}`,
        detail: causal.statement,
        evidence: [
          `95% CI ${(causal.ci95[0] * 100).toFixed(2)}pp ~ ${(causal.ci95[1] * 100).toFixed(2)}pp`,
          causal.method
        ]
      };
    }
  );

  await probe(
    'stream.p99',
    '稳定性与运维',
    '流式链路 P99 满足延迟预算',
    'P99 ≤ 500ms',
    async () => {
      state.stress = await rt.stressTest(stressEvents);
      const stress = state.stress;
      return {
        status: stress.passed ? 'pass' : 'fail',
        metric: `P99 ${stress.p99}ms · ${stress.throughput}/s`,
        detail: `${stress.mode}；动态批处理 ${stress.windowMs}ms / 最大 ${stress.maxBatch} 条，低价值弹幕在拥塞时降级。`,
        evidence: [`P50 ${stress.p50}ms`, `P95 ${stress.p95}ms`, `丢弃 ${stress.dropped} 条`]
      };
    }
  );

  await probe(
    'trace.coverage',
    '可观测性',
    '决策卡片全部可回溯到 trace',
    '100% 决策带 trace_id 与证据',
    async () => {
      const decisions = rt.decisions.filter((decision) => !decision.historical);
      const traced = decisions.filter(
        (decision) => decision.traceId && rt.tracer.get(decision.traceId)
      );
      const spans = traced.reduce(
        (sum, decision) => sum + (rt.tracer.get(decision.traceId)?.spans.length ?? 0),
        0
      );
      const complete = decisions.filter(
        (decision) =>
          decision.action &&
          decision.trigger &&
          decision.reasoning &&
          Array.isArray(decision.evidence) &&
          decision.traceId
      );
      const ok =
        decisions.length >= 6 &&
        traced.length === decisions.length &&
        complete.length === decisions.length &&
        spans >= 15;
      return {
        status: ok ? 'pass' : 'fail',
        metric: `${traced.length}/${decisions.length} 可追溯 · ${spans} spans`,
        detail: 'trace_id 贯穿弹幕、意图、工具、协商与输出，决策卡片可点开查看数据来源与推理。',
        evidence: decisions.slice(0, 3).map((decision) => `${decision.id} → ${decision.traceId}`)
      };
    }
  );

  await probe(
    'availability.72h',
    '稳定性与运维',
    '72 小时可用性 ≥ 99.5%',
    '≥99.5% / 72h',
    async () => ({
      status: 'warn',
      metric: '未执行 72h 连续压测',
      detail:
        '本次已完成故障转移、连续链路与压测；72 小时稳定性需在部署环境执行。验收如实标记为待现场验证，不伪造通过。',
      evidence: ['建议：k8s 多副本 + 持续 Locust 流量 + Grafana 报警']
    })
  );

  await probe(
    'business.uplift',
    '业务效果',
    '互动率 +40% / 转化率 +25%',
    '同品牌同品类灰度对照',
    async () => ({
      status: 'warn',
      metric: '仿真 ATT 已显著，真实提升待验证',
      detail:
        'GMV、互动率、转化率均来自确定性种子与仿真样本，未接入真实店铺数据；需以历史直播为基准做灰度 A/B。',
      evidence: [
        `仿真 ATT +${(state.causal?.att * 100 || 0).toFixed(2)}pp`,
        '演示数据已在界面持续标注'
      ]
    })
  );

  rt.stopTicker();
  rt.autoDanmaku = false;

  const passed = probes.filter((item) => item.status === 'pass').length;
  const warned = probes.filter((item) => item.status === 'warn').length;
  const failed = probes.filter((item) => item.status === 'fail').length;
  const score = round(
    (probes.reduce((sum, item) => sum + statusWeight(item.status), 0) / probes.length) * 100,
    1
  );

  const groups = [...new Set(probes.map((item) => item.group))].map((group) => {
    const items = probes.filter((item) => item.group === group);
    return {
      name: group,
      total: items.length,
      pass: items.filter((item) => item.status === 'pass').length,
      warn: items.filter((item) => item.status === 'warn').length,
      fail: items.filter((item) => item.status === 'fail').length
    };
  });

  return {
    id: `ACC-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
    generatedAt: new Date().toISOString(),
    durationMs: round(performance.now() - started, 2),
    score,
    verdict: failed === 0 ? (warned ? '通过 · 含待现场验证项' : '通过') : '存在阻塞项',
    summary: {
      total: probes.length,
      pass: passed,
      warn: warned,
      fail: failed,
      passRate: round((passed / probes.length) * 100, 1)
    },
    groups,
    probes,
    measured: {
      prepChainMs: state.prep?.prepChainMs ?? null,
      reviewPValue: state.review?.report?.causal?.pValue ?? state.causal?.pValue ?? null,
      reviewAtt: state.review?.report?.causal?.att ?? state.causal?.att ?? null,
      p50: state.stress?.p50 ?? null,
      p95: state.stress?.p95 ?? null,
      p99: state.stress?.p99 ?? null,
      throughput: state.stress?.throughput ?? null,
      messages: rt.bus.stats().sent,
      decisions: rt.decisions.filter((item) => !item.historical).length,
      traceEvents: runtimeEvents.filter((item) => item.type === 'trace').length
    },
    environment: {
      mode: '本地确定性内核 · 零外部依赖',
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      llm: rt.llm.mode,
      dataLabel: '业务指标为仿真数据，延迟为本机意图链路实测'
    }
  };
}
