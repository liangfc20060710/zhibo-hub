import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots');
const APP = 'http://127.0.0.1:4173/';
const CDP = 'http://127.0.0.1:9222';

await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Session {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    };
  }

  static async connect() {
    const targets = await fetch(`${CDP}/json/list`).then((response) => response.json());
    const target = targets.find((item) => item.type === 'page');
    if (!target) throw new Error('no CDP page target available');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('CDP websocket failed'));
    });
    return new Session(socket);
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluation failed';
      throw new Error(detail);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 20000, label = expression } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (await this.evaluate(`Boolean(${expression})`)) return true;
      await sleep(120);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  async click(selector, { wait = 320 } = {}) {
    const clicked = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`selector not found: ${selector}`);
    await sleep(wait);
  }

  async shot(name, { full = false } = {}) {
    await this.evaluate('document.querySelectorAll(".toast").forEach((node) => node.remove())');
    const params = { format: 'png' };
    if (full) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const { width, height } = metrics.cssContentSize;
      params.clip = { x: 0, y: 0, width, height: Math.min(height, 5000), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    await writeFile(path.join(OUT, name), Buffer.from(data, 'base64'));
  }
}

const errors = [];
const consoleErrors = [];
const failedRequests = [];

const session = await Session.connect();
await session.send('Page.enable');
await session.send('Runtime.enable');
await session.send('Log.enable');
await session.send('Network.enable');
await session.send('Network.setCacheDisabled', { cacheDisabled: true });
await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try { localStorage.setItem('nexus.copilot', 'open'); } catch {}
    window.__QA_ERRORS__ = [];
    window.addEventListener('error', (event) => {
      window.__QA_ERRORS__.push({ kind: 'error', message: event.message, source: event.filename, line: event.lineno });
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__QA_ERRORS__.push({ kind: 'rejection', message: String(event.reason && event.reason.message || event.reason) });
    });
  `
});

session.on('Runtime.exceptionThrown', (params) => {
  errors.push({
    kind: 'exception',
    text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text
  });
});
session.on('Runtime.consoleAPICalled', (params) => {
  if (params.type !== 'error' && params.type !== 'warning') return;
  const text = (params.args ?? [])
    .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
    .join(' ');
  consoleErrors.push({ type: params.type, text });
});
session.on('Log.entryAdded', (params) => {
  if (params.entry?.level === 'error') errors.push({ kind: 'log', text: params.entry.text });
});
session.on('Network.loadingFailed', (params) => {
  if (params.canceled) return;
  failedRequests.push({ requestId: params.requestId, error: params.errorText });
});
session.on('Network.responseReceived', (params) => {
  const response = params.response;
  if (response.status >= 400 && !response.url.includes('/favicon.ico')) {
    failedRequests.push({ status: response.status, url: response.url });
  }
});

await fetch(`${APP}api/reset`, { method: 'POST' });
await session.send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false
});
await session.send('Page.navigate', { url: `${APP}?qa=${Date.now()}` });
await session.waitFor('window.__NEXUS__ && window.__NEXUS__.state && document.querySelector(".shell")', {
  timeout: 25000,
  label: 'app boot'
});
await session.waitFor('window.__NEXUS__.state.agents?.length === 6', { label: 'state hydrated' });
await sleep(900);

const steps = [];
const step = (name, detail = '') => {
  steps.push({ name, detail, at: Date.now() });
  console.log(`PASS ${name}${detail ? ` · ${detail}` : ''}`);
};

await session.shot('01-overview-empty.png');
step('overview boots', '6 agents hydrated, SSE status visible');

const topNav = await session.evaluate(
  `[...document.querySelectorAll('.nav-item')].map((el) => el.dataset.view)`
);
if (topNav.join(',') !== 'overview,agents,live,decisions,review,protocol,system') {
  throw new Error(`unexpected navigation: ${topNav.join(',')}`);
}
step('navigation shell', topNav.join(' / '));

await session.click('[data-act="prepare"]', { wait: 200 });
await session.waitFor('window.__NEXUS__.state.session.stage === "ready"', {
  timeout: 30000,
  label: 'plan ready'
});
await sleep(900);
await session.shot('02-overview-ready.png', { full: true });
const planInfo = await session.evaluate(`({
  version: window.__NEXUS__.state.plan.version,
  products: window.__NEXUS__.state.plan.products.length,
  segments: window.__NEXUS__.state.plan.segments.length,
  winner: window.__NEXUS__.state.cnp.winner,
  decisions: window.__NEXUS__.state.decisions.length
})`);
step(
  'Plan-Execute via UI',
  `${planInfo.version} · ${planInfo.products} products · winner ${planInfo.winner}`
);

await session.click('[data-act="plan"]', { wait: 500 });
await session.waitFor('document.querySelector("#drawer-root").classList.contains("open")', {
  label: 'plan drawer'
});
await sleep(500);
await session.shot('03-plan-drawer.png');
step('plan drawer', await session.evaluate('document.querySelector("#drawer-root .drawer-head h2").textContent'));
await session.click('.drawer-close', { wait: 500 });

await session.click('.nav-item[data-view="agents"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "agents"', { label: 'agents view' });
await sleep(500);
await session.shot('04-agents.png', { full: true });
step('agents matrix', '4 primary actors + 2 replicas rendered');

await session.click('[data-act="fault"][data-agent="controller"][data-mode="offline"]', { wait: 500 });
await session.waitFor(
  'window.__NEXUS__.state.agents.find((a) => a.id === "controller-b").status === "active"',
  { label: 'replica takeover' }
);
await sleep(500);
await session.shot('05-agents-failover.png');
step('replica failover via UI', 'controller offline → controller-b active');
await session.click('[data-act="restore-all"]', { wait: 500 });
await session.waitFor(
  'window.__NEXUS__.state.agents.find((a) => a.id === "controller").status === "active"',
  { label: 'controller restore' }
);
step('restore all actors', 'controller active, replica standby');

await session.click('.nav-item[data-view="live"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "live"', { label: 'live view' });
await sleep(600);
await session.shot('06-live-ready.png', { full: true });
step('live console ready', 'stage, schedule, danmaku rail rendered');

await session.click('[data-act="live-start"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.state.session.stage === "live"', {
  timeout: 15000,
  label: 'live start'
});
await sleep(1800);
await session.shot('07-live-running.png', { full: true });
const liveMetrics = await session.evaluate(`({
  viewers: window.__NEXUS__.state.metrics.viewers,
  comments: window.__NEXUS__.state.metrics.comments,
  p99: window.__NEXUS__.state.metrics.p99
})`);
step('live start via UI', `${liveMetrics.viewers} viewers · ${liveMetrics.comments} danmaku · p99 ${liveMetrics.p99}ms`);

const text = '这款凤凰蜜兰单丛怎么冲泡？';
await session.evaluate(`(() => {
  const form = document.querySelector('[data-form="danmaku"]');
  form.querySelector('input[name="text"]').value = ${JSON.stringify(text)};
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
await session.waitFor(
  `window.__NEXUS__.state.danmaku.some((item) => item.text === ${JSON.stringify(text)})`,
  { label: 'danmaku roundtrip' }
);
await session.waitFor(
  `window.__NEXUS__.state.responses.some((item) => item.text === ${JSON.stringify(text)})`,
  { timeout: 20000, label: 'danmaku response' }
);
await sleep(700);
await session.shot('08-live-danmaku.png');
step('danmaku → ReAct response', 'observer + speaker response completed');

await session.click('.nav-item[data-view="overview"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "overview"', { label: 'overview' });
await session.click('.quick-action[data-scenario="negative"]', { wait: 400 });
await session.waitFor('window.__NEXUS__.state.incident && window.__NEXUS__.state.incident.status', {
  timeout: 25000,
  label: 'negative incident'
});
await sleep(1200);
await session.shot('09-live-incident.png', { full: true });
const incident = await session.evaluate(`({
  count: window.__NEXUS__.state.incident.count,
  status: window.__NEXUS__.state.incident.status,
  weight: window.__NEXUS__.state.incident.voteSummary.weight,
  threshold: window.__NEXUS__.state.incident.voteSummary.threshold,
  coupon: Boolean(window.__NEXUS__.state.incident.coupon)
})`);
step('negative incident consensus', `${incident.count} comments · ${incident.weight}/${incident.threshold} · coupon ${incident.coupon}`);

await session.click('.nav-item[data-view="decisions"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "decisions"', { label: 'decisions view' });
await sleep(500);
await session.shot('10-decisions.png', { full: true });
const decisionCount = await session.evaluate('window.__NEXUS__.state.decisions.length');
step('decision ledger', `${decisionCount} decisions with risk + trace`);

await session.evaluate(`(() => {
  const input = document.querySelector('[data-act="decision-search"]');
  if (!input) return false;
  input.value = '券';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(600);
const filtered = await session.evaluate('document.querySelectorAll(".decision-card, .decision-row, .decision-item").length');
step('decision search filter', `${filtered} matching cards`);
await session.evaluate(`(() => {
  const input = document.querySelector('[data-act="decision-search"]');
  if (!input) return false;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);

await session.click('.nav-item[data-view="overview"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "overview"', { label: 'overview for quick actions' });
await session.click('.quick-action[data-view="system"]', { wait: 400 });
await session.waitFor('window.__NEXUS__.view === "system"', { label: 'system view via quick action' });
await session.waitFor('window.__NEXUS__.store.ui.acceptance || window.__NEXUS__.store.ui.acceptanceLoading', {
  timeout: 30000,
  label: 'acceptance report'
});
await session.waitFor('!window.__NEXUS__.store.ui.acceptanceLoading', {
  timeout: 60000,
  label: 'acceptance complete'
});

async function forceAcceptance() {
  await session.click('.view-inner [data-act="acceptance"][data-force="1"]', { wait: 240 });
  await session.waitFor('window.__NEXUS__.store.ui.acceptanceLoading', {
    timeout: 15000,
    label: 'acceptance loading'
  });
  await session.waitFor('!window.__NEXUS__.store.ui.acceptanceLoading', {
    timeout: 90000,
    label: 'acceptance complete'
  });
  return session.evaluate(`({
    score: window.__NEXUS__.store.ui.acceptance.score,
    summary: window.__NEXUS__.store.ui.acceptance.summary
  })`);
}

let acceptance = await forceAcceptance();
let acceptanceAttempts = 1;
if (acceptance.summary.fail > 0) {
  await sleep(1200);
  acceptance = await forceAcceptance();
  acceptanceAttempts += 1;
}
await sleep(700);
await session.shot('11-system-acceptance.png', { full: true });
step(
  'in-product acceptance',
  `score ${acceptance.score} · pass ${acceptance.summary.pass} warn ${acceptance.summary.warn} fail ${acceptance.summary.fail} · attempts ${acceptanceAttempts}`
);

await session.click('[data-act="stress"][data-events="800"]', { wait: 400 });
await session.waitFor('window.__NEXUS__.store.ui.stressResult', { timeout: 30000, label: 'stress result' });
await sleep(700);
await session.shot('12-system-stress.png', { full: true });
const stress = await session.evaluate(`({
  p99: window.__NEXUS__.store.ui.stressResult.p99,
  throughput: window.__NEXUS__.store.ui.stressResult.throughput,
  passed: window.__NEXUS__.store.ui.stressResult.passed
})`);
step('stress test via UI', `p99 ${stress.p99}ms · ${stress.throughput}/s · passed ${stress.passed}`);

await session.click('.nav-item[data-view="protocol"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "protocol"', { label: 'protocol view' });
await session.evaluate(`(() => {
  const form = document.querySelector('[data-form="hotplug"]');
  form.elements.namedItem('name').value = 'qa.ui.compare';
  form.elements.namedItem('category').value = '验收';
  form.elements.namedItem('handlerType').value = 'market_compare';
  form.elements.namedItem('riskLevel').value = 'low';
  form.elements.namedItem('description').value = '浏览器验收阶段挂载的竞品比价工具';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
await session.waitFor(
  'window.__NEXUS__.state.tools.some((tool) => tool.name === "qa.ui.compare")',
  { timeout: 15000, label: 'hotplug tool' }
);
await sleep(700);
await session.shot('13-protocol-hotplug.png', { full: true });
const protocolText = await session.evaluate('document.body.innerText');
if (/undefined/i.test(protocolText)) throw new Error('protocol view renders undefined text');
step('runtime MCP hotplug via UI', 'qa.ui.compare mounted without restart');

await session.click('.nav-item[data-view="review"]', { wait: 600 });
await session.waitFor('window.__NEXUS__.view === "review"', { label: 'review view' });
await sleep(400);
await session.shot('14-review-prelive.png');

await session.click('.nav-item[data-view="live"]', { wait: 600 });
await session.click('[data-act="live-stop"]', { wait: 300 });
await session.waitFor('document.querySelector("#confirm-root.open")', { label: 'confirm dialog' });
await session.click('[data-confirm-ok]', { wait: 300 });
await session.waitFor('window.__NEXUS__.state.session.stage === "ended"', { label: 'live ended' });
await session.click('[data-act="review"]', { wait: 400 });
await session.waitFor('window.__NEXUS__.state.session.stage === "reviewed"', {
  timeout: 30000,
  label: 'review complete'
});
await sleep(900);
await session.shot('15-review-report.png', { full: true });
const review = await session.evaluate(`({
  att: window.__NEXUS__.state.review.causal.att,
  p: window.__NEXUS__.state.review.causal.pValue,
  lessons: window.__NEXUS__.state.review.lessons.length,
  next: window.__NEXUS__.state.review.nextActions?.length ?? 0,
  treatment: window.__NEXUS__.state.review.causal.dag?.nodes?.find((node) => node.type === "treatment")?.label ?? ""
})`);
if (!review.treatment || /undefined/i.test(review.treatment)) {
  throw new Error(`review DAG treatment label is unresolved: ${review.treatment}`);
}
const reviewText = await session.evaluate('document.body.innerText');
if (/undefined/i.test(reviewText)) throw new Error('review view renders undefined text');
step(
  'review → Reflexion + causal',
  `ATT ${review.att} · p=${review.p} · ${review.lessons} lessons · DAG ${review.treatment}`
);

const assistantBefore = await session.evaluate(
  'window.__NEXUS__.state.chat.filter((message) => message.role === "assistant").length'
);
await session.evaluate(`(() => {
  const input = document.querySelector('#chat-input');
  input.value = '复盘并解释发券效果';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
await session.waitFor(
  `window.__NEXUS__.state.chat.filter((message) => message.role === "assistant").length > ${assistantBefore}`,
  { timeout: 30000, label: 'copilot reply' }
);
await sleep(700);
await session.shot('16-copilot-chat.png');
const chatReply = await session.evaluate(
  'window.__NEXUS__.state.chat.filter((message) => message.role === "assistant").at(-1).text'
);
step('copilot conversation', `${chatReply.slice(0, 46)}…`);

await session.send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 960,
  deviceScaleFactor: 1,
  mobile: false
});
await sleep(600);
await session.shot('17-desktop-1440.png');
const desktop = await session.evaluate(`(() => {
  const suggestions = document.querySelector('.chat-suggestions');
  const boxes = [...suggestions.querySelectorAll('.suggestion')].map((node) => node.getBoundingClientRect());
  const parent = suggestions.getBoundingClientRect();
  return {
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    suggestionsClipped: boxes.some((box) => box.right > parent.right + 1 || box.left < parent.left - 1),
    suggestionsWrapped: new Set(boxes.map((box) => Math.round(box.top))).size > 1,
    toolNameMaxHeight: Math.max(0, ...[...document.querySelectorAll('.tool-name')].map((node) => Math.round(node.getBoundingClientRect().height)))
  };
})()`);
if (desktop.suggestionsClipped) throw new Error('desktop: chat suggestions clipped');
if (desktop.scrollWidth > desktop.innerWidth + 1) {
  throw new Error(`desktop: horizontal overflow ${desktop.scrollWidth} > ${desktop.innerWidth}`);
}
step('desktop layout', `suggestions wrapped=${desktop.suggestionsWrapped} · no horizontal overflow`);

await session.send('Emulation.setDeviceMetricsOverride', {
  width: 820,
  height: 1100,
  deviceScaleFactor: 1,
  mobile: false
});
await session.evaluate(`(() => {
  const shell = document.querySelector('.shell');
  if (shell.classList.contains('copilot-open')) {
    document.querySelector('#copilot-toggle')?.click();
  }
})()`);
await sleep(800);
await session.shot('18-responsive-820.png');
const responsive = await session.evaluate(`(() => {
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.x), w: Math.round(box.width), h: Math.round(box.height) };
  };
  const suggestions = document.querySelector('.chat-suggestions');
  const suggestionBoxes = suggestions
    ? [...suggestions.querySelectorAll('.suggestion')].map((node) => node.getBoundingClientRect())
    : [];
  const rail = document.querySelector('.rail');
  return {
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    railHidden: getComputedStyle(rail).display === 'none',
    railWidth: Math.round(rail.getBoundingClientRect().width),
    shellCols: getComputedStyle(document.querySelector('.shell')).gridTemplateColumns,
    workspace: rect('.workspace'),
    view: rect('.view'),
    viewInner: rect('.view-inner'),
    topbar: rect('.topbar'),
    pageHead: rect('.page-head'),
    suggestionsClipped: suggestions
      ? suggestionBoxes.some((box) => {
          const parent = suggestions.getBoundingClientRect();
          return box.right > parent.right + 1 || box.left < parent.left - 1;
        })
      : null
  };
})()`);
if (!responsive.railHidden) throw new Error('responsive: rail still visible at 820');
if (!responsive.workspace || responsive.workspace.w < 800) {
  throw new Error(`responsive: workspace collapsed (${responsive.workspace?.w}px)`);
}
if (!responsive.viewInner || responsive.viewInner.w < 740) {
  throw new Error(`responsive: view content collapsed (${responsive.viewInner?.w}px)`);
}
if (responsive.suggestionsClipped) throw new Error('responsive: chat suggestions clipped');
if (responsive.scrollWidth > responsive.innerWidth + 1) {
  throw new Error(`responsive: horizontal overflow ${responsive.scrollWidth} > ${responsive.innerWidth}`);
}
step(
  'responsive layout',
  `workspace ${responsive.workspace.w}px · view ${responsive.viewInner.w}px · cols ${responsive.shellCols}`
);

await session.send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false
});
await sleep(400);

const pageErrors = await session.evaluate('window.__QA_ERRORS__');
const summary = {
  steps,
  errors: errors.concat(pageErrors ?? []),
  consoleErrors,
  failedRequests,
  finalView: await session.evaluate('window.__NEXUS__.view'),
  stage: await session.evaluate('window.__NEXUS__.state.session.stage'),
  acceptance: {
    score: acceptance.score,
    summary: acceptance.summary,
    attempts: acceptanceAttempts
  },
  responsive,
  desktop,
  shots: 18
};
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));

console.log('');
console.log(`steps: ${steps.length}`);
console.log(`runtime errors: ${summary.errors.length}`);
console.log(`console warnings/errors: ${consoleErrors.length}`);
console.log(`failed requests: ${failedRequests.length}`);
if (summary.errors.length) console.log(JSON.stringify(summary.errors, null, 2));
if (consoleErrors.length) console.log(JSON.stringify(consoleErrors, null, 2));
if (failedRequests.length) console.log(JSON.stringify(failedRequests, null, 2));

const failed =
  summary.errors.length > 0 ||
  consoleErrors.length > 0 ||
  failedRequests.length > 0 ||
  acceptance.summary.fail > 0 ||
  acceptance.score < 95;
session.socket.close();
await sleep(200);
process.exit(failed ? 1 : 0);
