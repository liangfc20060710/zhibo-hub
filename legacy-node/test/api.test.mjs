import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForHealth(timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('server did not become healthy');
}

async function call(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

test('HTTP API: full operating loop, security gates and SSE', async (t) => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  child.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2500))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'local-deterministic');
  assert.equal(health.stage, 'prep');

  const initial = await call('/api/state');
  assert.equal(initial.status, 200);
  assert.equal(initial.payload.ok, true);
  assert.equal(initial.payload.state.agents.length, 6);
  assert.ok(initial.payload.state.tools.length >= 15);
  assert.equal(initial.payload.state.session.stage, 'prep');

  const asset = await fetch(`${BASE}/assets/live-stage.jpg`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(asset.headers.get('content-length')) > 1000);

  const traversal = await fetch(`${BASE}/%2e%2e/server.mjs`);
  assert.notEqual(traversal.status, 200, 'path traversal must not leak server.mjs');

  const sseController = new AbortController();
  const sse = await fetch(`${BASE}/api/events`, { signal: sseController.signal });
  assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = sse.body.getReader();
  const firstChunk = await reader.read();
  const hello = new TextDecoder().decode(firstChunk.value);
  assert.match(hello, /^event: hello/);
  assert.match(hello, /"stage":"prep"/);
  sseController.abort();

  const prepare = await call('/api/prepare', { method: 'POST' });
  assert.equal(prepare.status, 200);
  assert.equal(prepare.payload.result.plan.version, 'v1.1');
  assert.equal(prepare.payload.result.contract.winner, 'selector');
  assert.equal(prepare.payload.state.session.stage, 'ready');
  assert.ok(prepare.payload.state.metricsHistory.length >= 1);

  const traceId = prepare.payload.result.trace.id;
  const trace = await call(`/api/trace/${encodeURIComponent(traceId)}`);
  assert.equal(trace.status, 200);
  assert.equal(trace.payload.trace.id, traceId);
  assert.ok(trace.payload.trace.spans.length >= 3);

  const live = await call('/api/live/start', { method: 'POST' });
  assert.equal(live.status, 200);
  assert.equal(live.payload.state.session.stage, 'live');

  const danmaku = await call('/api/danmaku', {
    method: 'POST',
    body: { text: '这款凤凰蜜兰单丛怎么冲泡？', user: '验收观众' }
  });
  assert.equal(danmaku.status, 200);
  assert.ok(danmaku.payload.result.result.response.text);
  assert.equal(danmaku.payload.state.danmaku.at(-1).text, '这款凤凰蜜兰单丛怎么冲泡？');

  const blocked = await call('/api/tools/call', {
    method: 'POST',
    body: { name: 'pricing.change', args: { productId: 'P-02', price: 199 } }
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.payload.error.code, 'APPROVAL_REQUIRED');

  const negative = await call('/api/scenario', { method: 'POST', body: { type: 'negative' } });
  assert.equal(negative.status, 200);
  assert.equal(negative.payload.result.injected, 3);
  assert.ok(negative.payload.state.consensusHistory.length >= 1);
  const incidentVote = negative.payload.state.consensusHistory[0];
  assert.ok(incidentVote.weight >= incidentVote.threshold);

  const coupon = await call('/api/scenario', { method: 'POST', body: { type: 'coupon' } });
  assert.equal(coupon.status, 200);
  assert.equal(coupon.payload.result.vote.approved, true);
  assert.ok(coupon.payload.result.vote.approvalId);
  assert.ok(coupon.payload.result.coupon.label);
  assert.ok(coupon.payload.state.coupon.label, 'state coupon must carry the same display label');

  const price = await call('/api/scenario', { method: 'POST', body: { type: 'price' } });
  assert.equal(price.status, 200);
  assert.equal(price.payload.result.veto.code, 'PRICE_FLOOR');

  const fault = await call('/api/fault', {
    method: 'POST',
    body: { agent: 'controller', action: 'offline' }
  });
  assert.equal(fault.status, 200);
  assert.equal(fault.payload.result.replica, 'controller-b');
  const restored = await call('/api/fault', {
    method: 'POST',
    body: { agent: 'controller', action: 'restore' }
  });
  assert.equal(restored.status, 200);

  const hotplug = await call('/api/tools/hotplug', {
    method: 'POST',
    body: {
      name: 'qa.margin',
      category: '验收',
      handlerType: 'margin_calc',
      riskLevel: 'low',
      description: '验收用毛利工具'
    }
  });
  assert.equal(hotplug.status, 200);
  assert.equal(hotplug.payload.spec.source, 'hotplug');
  const toolCall = await call('/api/tools/call', {
    method: 'POST',
    body: { name: 'qa.margin', args: { price: 199, cost: 80 } }
  });
  assert.equal(toolCall.status, 200);
  assert.ok(Number.isFinite(toolCall.payload.result.result.grossMargin));
  const removed = await call('/api/tools/remove', { method: 'POST', body: { name: 'qa.margin' } });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.removed, true);

  const chat = await call('/api/chat', { method: 'POST', body: { message: '查看当前状态' } });
  assert.equal(chat.status, 200);
  assert.ok(chat.payload.result.message.text.length > 10);
  assert.ok(chat.payload.state.chat.at(-1).role === 'assistant');

  const stress = await call('/api/stress', { method: 'POST', body: { events: 400 } });
  assert.equal(stress.status, 200);
  assert.equal(stress.payload.result.events, 400);
  assert.ok(stress.payload.result.p99 <= stress.payload.result.targetP99);
  assert.ok(stress.payload.state.loadTest);

  const stop = await call('/api/live/stop', { method: 'POST' });
  assert.equal(stop.status, 200);
  assert.equal(stop.payload.state.session.stage, 'ended');

  const review = await call('/api/review', { method: 'POST' });
  assert.equal(review.status, 200);
  assert.equal(review.payload.state.session.stage, 'reviewed');
  assert.ok(Number.isFinite(review.payload.result.report.causal.pValue));
  assert.ok(review.payload.result.report.causal.ci95.length === 2);

  const reviewChat = await call('/api/chat', {
    method: 'POST',
    body: { message: '复盘并解释发券效果' }
  });
  assert.equal(reviewChat.status, 200);
  assert.equal(reviewChat.payload.state.session.stage, 'reviewed', 'review chat must not restart live');
  assert.equal(reviewChat.payload.state.session.id, review.payload.state.session.id);
  assert.equal(reviewChat.payload.state.coupon?.id, coupon.payload.state.coupon?.id, 'review chat must not reissue a coupon');
  assert.match(reviewChat.payload.result.message.text, /因果结论/);

  const acceptance = await call('/api/acceptance?force=1');
  assert.equal(acceptance.status, 200);
  assert.ok(acceptance.payload.report.score >= 90);
  assert.equal(acceptance.payload.report.summary.fail, 0);

  const reset = await call('/api/reset', { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.equal(reset.payload.state.session.stage, 'prep');
  assert.equal(reset.payload.state.plan, null);

  assert.doesNotMatch(serverLog, /UnhandledPromiseRejection|TypeError|ReferenceError/);
});
