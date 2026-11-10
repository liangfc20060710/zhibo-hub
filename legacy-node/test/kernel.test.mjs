import test from 'node:test';
import assert from 'node:assert/strict';
import { ZhiboRuntime } from '../src/orchestrator.mjs';

function createRuntime() {
  return new ZhiboRuntime({ autoSimulate: false, seed: true });
}

test('prepare: CNP selects selector and publishes a complete plan', async () => {
  const runtime = createRuntime();
  try {
    const result = await runtime.prepare();
    const state = runtime.snapshot();

    assert.equal(state.session.stage, 'ready');
    assert.equal(state.plan.version, 'v1.1');
    assert.ok(state.plan.products.length >= 3);
    assert.ok(state.plan.segments.length >= 4);
    assert.ok(state.plan.scripts.length >= 3);
    assert.ok(state.plan.memoryHits.length >= 1);
    assert.equal(result.contract.winner, 'selector');
    assert.ok(result.contract.bids.length >= 2);
    assert.ok(state.cnp.bids.every((bid) => Number.isFinite(bid.score)));
    assert.equal(state.consensusHistory.length >= 0, true);
    assert.ok(state.decisions.some((decision) => decision.agent === 'selector'));
    assert.ok(state.tools.length >= 15);
    assert.ok(state.tools.some((tool) => tool.requiresApproval));
    assert.ok(state.tools.every((tool) => tool.parameters && tool.riskLevel));
  } finally {
    runtime.stopTicker();
  }
});

test('live scenarios: weighted consensus, compliance veto and coupon approval stay consistent', async () => {
  const runtime = createRuntime();
  try {
    await runtime.prepare();
    runtime.startLive();
    assert.equal(runtime.snapshot().session.stage, 'live');

    const negative = await runtime.runScenario('negative');
    assert.equal(negative.injected, 3);
    assert.ok(negative.incident);
    assert.equal(negative.incident.status, 'executed');
    assert.ok(negative.incident.count >= 2);
    assert.ok(negative.incident.voteSummary.weight >= negative.incident.voteSummary.threshold);
    const consensus = runtime.lastConsensus;
    assert.ok(consensus);
    assert.ok(consensus.weight >= consensus.threshold, 'negative incident must pass weighted consensus');
    assert.equal(consensus.vetoed, false);

    const extreme = await runtime.runScenario('extreme');
    assert.equal(extreme.injected, 1);
    const response = extreme.result?.result?.response;
    assert.ok(response?.text, 'guardrail must return a rewritten response');
    assert.ok(response?.guardrail?.violations?.length >= 1);
    assert.ok(response?.guardrail?.rewritten?.length > 0);
    assert.ok(!response.guardrail.rewritten.includes('价价'), 'rewrite must not duplicate the price suffix');

    const coupon = await runtime.runScenario('coupon');
    assert.equal(coupon.vote.approved, true);
    assert.ok(coupon.vote.weight >= coupon.vote.threshold);
    assert.ok(coupon.coupon?.id, 'approved coupon must be issued by the tool layer');
    assert.equal(coupon.coupon.status, 'active');
    assert.ok(coupon.coupon.label, 'issued coupon must carry a display label');
    assert.ok(coupon.vote.approvalId);

    const price = await runtime.runScenario('price');
    assert.equal(price.veto.code, 'PRICE_FLOOR');
    assert.equal(price.decision.status, 'vetoed');
    assert.ok(price.decision.consensus.vetoed);

    const surge = await runtime.runScenario('surge');
    assert.equal(surge.snapshot.events, 80);
    assert.ok(Number.isFinite(surge.snapshot.p99));

    const state = runtime.snapshot();
    assert.ok(state.consensusHistory.length >= 2);
    assert.ok(state.humanQueue.some((item) => item.status === 'open'));
    assert.ok(state.metrics.gmv > 0);
    assert.ok(state.metrics.viewers > 0);
  } finally {
    runtime.stopTicker();
  }
});

test('review: causal ATT is statistically reported and Reflexion lessons are stored', async () => {
  const runtime = createRuntime();
  try {
    await runtime.prepare();
    runtime.startLive();
    await runtime.runScenario('negative');
    await runtime.runScenario('coupon');
    runtime.stopLive();
    assert.equal(runtime.snapshot().session.stage, 'ended');

    const result = await runtime.review();
    const causal = result.report.causal;
    const state = runtime.snapshot();

    assert.equal(state.session.stage, 'reviewed');
    assert.ok(Number.isFinite(causal.att));
    const treatment = causal.dag.nodes.find((node) => node.type === 'treatment');
    assert.ok(treatment, 'review DAG must include a treatment node');
    assert.ok(!/undefined/.test(treatment.label), 'treatment label must be fully resolved');
    assert.ok(Number.isFinite(causal.pValue));
    assert.ok(causal.pValue >= 0 && causal.pValue <= 1);
    assert.ok(causal.ci95.length === 2);
    assert.ok(causal.ci95[0] <= causal.ci95[1]);
    assert.ok(result.report.lessons.length >= 1);
    assert.ok(result.report.memoryHits.length >= 1);
    assert.equal(state.reviewIsHistorical, false);
    assert.equal(state.review.id, result.report.id);
  } finally {
    runtime.stopTicker();
  }
});

test('resilience: hotplug, replica failover and measured stream stress', async () => {
  const runtime = createRuntime();
  try {
    await runtime.prepare();

    const spec = runtime.hotplugTool({
      name: 'test.margin',
      category: '测试',
      handlerType: 'margin_calc',
      riskLevel: 'low',
      description: '测试用毛利测算工具'
    });
    assert.equal(spec.name, 'test.margin');
    assert.equal(spec.source, 'hotplug');
    assert.ok(runtime.snapshot().tools.some((tool) => tool.name === 'test.margin'));

    const called = await runtime.registry.call('test.margin', { cost: 80, price: 199 });
    assert.ok(Number.isFinite(called.result.grossMargin));

    const failover = runtime.setAgentFault('controller', 'offline');
    assert.equal(failover.replica, 'controller-b');
    assert.ok(failover.active.includes('controller-b'));
    assert.equal(
      runtime.snapshot().agents.find((agent) => agent.id === 'controller-b').status,
      'active'
    );
    runtime.setAgentFault('controller', 'restore');
    assert.equal(
      runtime.snapshot().agents.find((agent) => agent.id === 'controller-b').status,
      'standby'
    );

    runtime.removeTool('test.margin');
    assert.equal(runtime.snapshot().tools.some((tool) => tool.name === 'test.margin'), false);

    const stress = await runtime.stressTest(600);
    assert.equal(stress.events, 600);
    assert.ok(stress.throughput > 0);
    assert.ok(stress.p99 <= stress.targetP99, `p99 ${stress.p99}ms should stay under ${stress.targetP99}ms`);
    assert.equal(runtime.snapshot().loadTest.events, 600);
  } finally {
    runtime.stopTicker();
  }
});

test('full acceptance harness reaches a passing score', async () => {
  const runtime = createRuntime();
  try {
    const report = await runtime.runAcceptance();
    assert.ok(report.score >= 90, `score ${report.score} should be at least 90`);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.probes.length, 20);
  } finally {
    runtime.stopTicker();
  }
});
