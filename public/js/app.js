import {
  NAV,
  VIEW_META,
  icon,
  logoMark,
  esc,
  agentInfo,
  riskMeta,
  shortId,
  stageMeta,
  fmtDuration,
  fmtMs,
  fmtNum,
  fmtClock,
  toast,
  openDrawer,
  closeDrawer,
  updateDrawer,
  confirmDialog
} from './ui.js';
import {
  renderView,
  chatHtml,
  decisionDetailHtml,
  agentDetailHtml,
  toolDetailHtml,
  traceDetailHtml,
  planDetailHtml,
  primaryAction
} from './views.js';
import { api, ApiError, EVENT_SOURCE_URL } from './api.js';

const EVENT_TYPES = [
  'agent',
  'session',
  'scenario',
  'log',
  'envelope',
  'consensus',
  'tool.registered',
  'human.escalated',
  'fault',
  'cnp',
  'blackboard',
  'trace',
  'tool.removed',
  'tool.error',
  'tool.called',
  'system.shutdown',
  'stream.metrics',
  'stream.batch',
  'stream.backpressure',
  'review',
  'response',
  'reset',
  'price.changed',
  'plan',
  'metrics',
  'loadtest',
  'incident',
  'decision',
  'danmaku',
  'coupon.issued',
  'chat',
  'agent.error'
];

const CHAT_SUGGESTIONS = [
  { text: '生成今晚的直播方案', stages: ['prep', 'ready'], reason: '筹备阶段可用' },
  { text: '注入负面舆情', stages: ['live', 'paused'], reason: '开播后可用' },
  { text: '把场控下线', stages: ['live', 'paused'], reason: '开播后可用' },
  { text: '复盘并解释发券效果', stages: ['ended', 'reviewed'], reason: '下播后可用' },
  { text: '查看当前状态', stages: null }
];

const LLM_CHAT_SUGGESTIONS = [
  { text: '分析当前直播数据，指出最需要关注的问题', stages: null },
  { text: '帮我写一段下一款商品的开场话术', stages: null },
  { text: '解释一下多智能体是如何协同决策的', stages: null },
  { text: '给我三条提升今晚转化的建议', stages: null }
];

const CHAT_MODE_META = {
  cmd: { placeholder: '让中枢执行或解释…', aria: 'Copilot 指令' },
  llm: { placeholder: '直接和大模型对话，例如：帮我分析当前直播数据…', aria: 'Copilot 对话' }
};

const INTENT_TEXT = {
  purchase_intent: '购买意图',
  product_question: '商品咨询',
  price_objection: '价格异议',
  authenticity_doubt: '真伪质疑',
  negative_feedback: '负面反馈',
  compliance_probe: '合规探针',
  churn_signal: '流失信号',
  low_value: '低价值'
};

const HOTPLUG_PRESETS = {
  market_compare: {
    name: 'market.compare',
    category: '行情',
    handlerType: 'market_compare',
    riskLevel: 'low',
    description: '接入同产区竞品价格，为讲解提供可核验锚点'
  },
  audience_weather: {
    name: 'audience.weather',
    category: '观众',
    handlerType: 'audience_weather',
    riskLevel: 'low',
    description: '估算当前人群活跃度与峰值时段，辅助排期'
  },
  margin_calc: {
    name: 'margin.calc',
    category: '经营',
    handlerType: 'margin_calc',
    riskLevel: 'medium',
    description: '按成本、折扣与运费测算单品毛利与保本价'
  }
};

const IGNORE_CLICKS = new Set(['decision-search', 'decision-agent', 'hotplug-submit']);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage may be unavailable
    }
  }
};

const store = {
  state: null,
  view: normalizeView(window.location.hash),
  ui: {
    decisionSearch: '',
    decisionAgent: 'all',
    decisionRisk: 'all',
    acceptance: null,
    acceptanceLoading: false,
    stressResult: null
  },
  connected: false,
  everConnected: false,
  eventCount: 0,
  chatSending: false,
  chatMode: storage.get('nexus.copilotMode') === 'llm' ? 'llm' : 'cmd',
  pendingUser: null,
  chatSignature: '',
  renderQueued: false,
  renderUrgent: false,
  renderAnimate: false,
  lastPaintAt: 0,
  paintTimer: null,
  resetScroll: false,
  syncTimer: null,
  syncInFlight: false,
  syncAgain: false,
  searchTimer: null,
  busy: new Set(),
  palette: { open: false, items: [], filtered: [], active: 0 },
  source: null
};

const refs = {};
const root = document.getElementById('app');

function normalizeView(value) {
  const text = String(value ?? '')
    .replace(/^#\/?/, '')
    .split('?')[0]
    .trim();
  return NAV.some((item) => item.id === text) ? text : 'overview';
}

function readHash() {
  return normalizeView(window.location.hash);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setProgress(active) {
  const bar = document.getElementById('app-progress');
  if (bar) bar.classList.toggle('active', Boolean(active));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTyping(target) {
  if (!target) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function errorMessage(error) {
  return error?.message ?? String(error ?? '未知错误');
}

function toastError(title, error) {
  toast(title, errorMessage(error), 'danger', 5200);
}

async function withBusy(key, fn) {
  if (store.busy.has(key)) {
    toast('动作仍在执行', '请等待当前任务完成，再触发同类动作。', 'warn', 2600);
    return null;
  }
  store.busy.add(key);
  setProgress(true);
  try {
    return await fn();
  } finally {
    store.busy.delete(key);
    if (!store.busy.size) setProgress(false);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shellHtml() {
  const meta = VIEW_META[store.view];
  const stage = stageMeta(store.state?.session?.stage ?? 'idle');
  const nav = NAV.map(
    (item) => `<button class="nav-item" data-act="navigate" data-view="${item.id}" title="${esc(
      `${item.label} · ${item.desc}（Alt+${item.shortcut}）`
    )}">
      ${icon(item.icon, 17)}
      <span class="nav-copy"><b>${esc(item.label)}</b><small>${esc(item.desc)}</small></span>
      <em>${esc(item.shortcut)}</em>
    </button>`
  ).join('');

  return `<div class="shell" id="shell">
    <aside class="rail">
      <a class="brand" href="#overview" data-act="navigate" data-view="overview" aria-label="返回本场总览">
        ${logoMark(38)}
        <div class="brand-text">
          <div class="brand-cn">智播中枢</div>
          <span class="brand-en">直播全流程 · 多智能体</span>
        </div>
      </a>
      <nav class="rail-nav" aria-label="主导航">
        <div class="nav-label">工作区</div>
        ${nav}
      </nav>
      <div class="rail-bottom">
        <div class="rail-telemetry">
          <div class="rail-telemetry-head">
            <span class="pulse-dot"></span>
            <span>集群在线</span>
          </div>
          <div class="rail-telemetry-metrics">
            <div><strong id="rail-agents">—</strong><span>智能体</span></div>
            <div><strong id="rail-messages">—</strong><span>消息</span></div>
            <div><strong id="rail-decisions">—</strong><span>决策</span></div>
            <div><strong id="rail-p99">—</strong><span>P99</span></div>
          </div>
          <div class="rail-signature">
            <span id="rail-version">内核 1.0</span>
            <span>本地</span>
          </div>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-heading">
          <div class="crumb" id="crumb">场次 · ${esc(store.state?.session?.id ?? 'SESSION')}</div>
          <h1 id="topbar-title">${esc(meta.title)}</h1>
          <p id="topbar-sub">${esc(meta.sub)}</p>
        </div>
        <div class="topbar-actions">
          <span class="stage-chip" id="stage-chip" data-stage="${esc(store.state?.session?.stage ?? 'prep')}">
            <span class="dot"></span><span id="stage-label">${esc(stage.label)}</span>
          </span>
          <button class="top-demo" id="demo-trigger" data-act="demo" title="按剧本自动走完筹备到复盘">
            ${icon('play', 13)}<span>一键演示</span>
          </button>
          <button class="command-trigger" data-act="palette" aria-label="打开命令面板">
            ${icon('search', 15)}
            <span>搜索或执行指令…</span>
            <kbd>⌘K</kbd>
          </button>
          <button class="icon-btn" data-act="function-map" title="功能地图" aria-label="功能地图">
            ${icon('map', 16)}
          </button>
          <button class="icon-btn" id="copilot-toggle" data-act="toggle-copilot" title="折叠 Copilot" aria-label="折叠 Copilot">
            ${icon('message', 16)}
          </button>
          <button class="icon-btn" data-act="refresh" title="同步运行状态" aria-label="同步运行状态">
            ${icon('refresh', 16)}
          </button>
          <button class="icon-btn" data-act="llm-config" title="大模型配置" aria-label="大模型配置">
            ${icon('settings', 16)}
          </button>
        </div>
      </header>

      <div class="view" id="view">
        <div class="view-inner" id="view-inner"></div>
      </div>

      <footer class="statusbar">
        <span class="sb-item"><span class="sb-dot" id="sb-dot"></span><span id="sb-conn">正在连接</span></span>
        <span class="sb-item sb-hide">A2A 消息 <b id="sb-bus">0</b></span>
        <span class="sb-item sb-hide">决策 <b id="sb-decisions">0</b></span>
        <span class="sb-item">P99 <b id="sb-p99">—</b></span>
        <span class="sb-item sb-chip" id="sb-stage">本地</span>
        <span class="sb-spacer"></span>
        <span class="sb-item sb-hide" id="sb-model">本地确定性内核</span>
        <span class="sb-item sb-hide">演示数据</span>
        <span class="sb-item" id="sb-clock">--:--:--</span>
      </footer>
    </div>

    <aside class="copilot" id="copilot" aria-label="中枢 Copilot">
      <div class="copilot-head">
        <div class="copilot-avatar">${icon('brain', 18)}</div>
        <div class="copilot-title">
          <strong>中枢 Copilot</strong>
          <span><i class="pulse-dot"></i><span id="copilot-mode">直连 4 个智能体</span></span>
        </div>
        <button class="icon-btn" data-act="toggle-copilot" aria-label="关闭 Copilot" style="width:30px;height:30px">
          ${icon('chevronRight', 14)}
        </button>
      </div>
      <div class="copilot-context">
        <span>协同中</span>
        <b id="copilot-context">—</b>
        <span class="tag">上下文</span>
      </div>
      <div class="chat-scroll" id="chat-scroll"></div>
      <div class="chat-suggestions" id="chat-suggestions" aria-label="快捷指令"></div>
      <div class="chat-composer">
        <div class="chat-modes" role="tablist" aria-label="Copilot 模式">
          <button type="button" class="chat-mode is-active" data-act="chat-mode" data-mode="cmd" role="tab" aria-selected="true">指令</button>
          <button type="button" class="chat-mode" data-act="chat-mode" data-mode="llm" role="tab" aria-selected="false">对话</button>
        </div>
        <form class="composer-box" id="chat-form" data-form="chat">
          <textarea id="chat-input" rows="1" maxlength="400" placeholder="让中枢执行或解释…" aria-label="Copilot 指令"></textarea>
          <button class="send-btn" type="submit" id="chat-send" aria-label="发送指令">${icon('send', 15)}</button>
        </form>
        <div class="composer-foot"><span>回车发送 · Shift+回车换行</span><span id="chat-state">就绪</span></div>
      </div>
    </aside>
  </div>
  <div class="app-progress" id="app-progress"><i></i></div>`;
}

function mountShell() {
  root.innerHTML = shellHtml();
  refs.shell = document.getElementById('shell');
  refs.view = document.getElementById('view');
  refs.viewInner = document.getElementById('view-inner');
  refs.chatScroll = document.getElementById('chat-scroll');
  applyCopilotPreference();
  applyChatMode();
}

function applyCopilotPreference() {
  const saved = storage.get('nexus.copilot');
  const wide = window.matchMedia('(min-width: 1441px)').matches;
  const open = wide ? saved !== 'closed' : saved === 'open';
  setCopilot(open, false);
}

function setCopilot(open, persist = true) {
  if (!refs.shell) return;
  refs.shell.classList.toggle('copilot-open', open);
  refs.shell.classList.toggle('copilot-closed', !open);
  const toggle = document.getElementById('copilot-toggle');
  if (toggle) {
    toggle.title = open ? '折叠 Copilot' : '展开 Copilot';
    toggle.setAttribute('aria-label', toggle.title);
  }
  if (persist) storage.set('nexus.copilot', open ? 'open' : 'closed');
}

function copilotIsOpen() {
  if (!refs.shell) return false;
  const wide = window.matchMedia('(min-width: 1441px)').matches;
  return wide ? !refs.shell.classList.contains('copilot-closed') : refs.shell.classList.contains('copilot-open');
}

function toggleCopilot() {
  setCopilot(!copilotIsOpen(), true);
}

function updateShell() {
  const state = store.state;
  if (!state || !refs.shell) return;
  const meta = VIEW_META[store.view];
  document.title = `${meta.title} · 智播中枢`;
  setText('topbar-title', meta.title);
  setText('topbar-sub', meta.sub);
  const crumb = document.getElementById('crumb');
  if (crumb) {
    crumb.textContent = `场次 · ${state.session?.id ?? 'SESSION'}`;
  }
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === store.view);
    el.setAttribute('aria-current', el.dataset.view === store.view ? 'page' : 'false');
  });

  const stage = state.session?.stage ?? 'idle';
  const stageInfo = stageMeta(stage);
  const chip = document.getElementById('stage-chip');
  if (chip) chip.dataset.stage = stage;
  setText(
    'stage-label',
    `${stageInfo.label}${stage === 'live' ? ` · ${fmtDuration(state.metrics?.elapsedSec ?? 0)}` : ''}`
  );

  const activeAgents = (state.agents ?? []).filter((agent) => agent.status === 'active');
  setText('rail-agents', String(state.agents?.length ?? 0));
  setText('rail-messages', fmtNum(state.busStats?.sent ?? 0));
  setText('rail-decisions', fmtNum(state.decisions?.length ?? 0));
  setText('rail-p99', fmtMs(state.metrics?.p99 ?? 0));
  setText('rail-version', `内核 ${state.meta?.version ?? '1.0'}`);
  setText('sb-conn', store.connected ? '实时通道已连接' : '正在重连');
  setText('sb-bus', fmtNum(state.busStats?.sent ?? 0));
  setText('sb-decisions', fmtNum(state.decisions?.length ?? 0));
  setText('sb-p99', fmtMs(state.metrics?.p99 ?? 0));
  setText('sb-stage', `本地 · ${stageInfo.label}`);
  setText('sb-model', '本地确定性内核');
  setText(
    'copilot-mode',
    store.chatMode === 'llm'
      ? '大模型对话模式'
      : `${activeAgents.length}/${state.agents?.length ?? 0} 在线 · 直连`
  );
  setText(
    'copilot-context',
    activeAgents.length ? activeAgents.map((agent) => agent.name).join(' · ') : '等待实例上线'
  );
  renderChatSuggestions();
  const dot = document.getElementById('sb-dot');
  if (dot) dot.classList.toggle('warn', !store.connected);
}

function requestPaint({ animate = false, urgent = false } = {}) {
  if (!store.state || !refs.viewInner) return;
  store.renderUrgent = store.renderUrgent || urgent;
  store.renderAnimate = store.renderAnimate || animate;
  if (store.renderQueued) return;
  store.renderQueued = true;
  requestAnimationFrame(() => {
    store.renderQueued = false;
    const options = { urgent: store.renderUrgent, animate: store.renderAnimate };
    store.renderUrgent = false;
    store.renderAnimate = false;
    paint(options);
  });
}

function captureKeep() {
  const active = document.activeElement;
  const snapshot = new Map();
  refs.viewInner.querySelectorAll('[data-keep]').forEach((el) => {
    const key = el.dataset.keep;
    if (!key || snapshot.has(key)) return;
    snapshot.set(key, {
      value: el.value ?? '',
      start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
      end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
      focused: el === active
    });
  });
  return snapshot;
}

function restoreKeep(snapshot) {
  refs.viewInner.querySelectorAll('[data-keep]').forEach((el) => {
    const saved = snapshot.get(el.dataset.keep);
    if (!saved) return;
    el.value = saved.value;
    if (saved.focused) {
      el.focus({ preventScroll: true });
      if (saved.start != null) {
        try {
          el.setSelectionRange(saved.start, saved.end);
        } catch {
          // select elements do not expose text selection
        }
      }
    }
  });
}

function danmakuPinned() {
  const stream = refs.viewInner.querySelector('[data-autoscroll]');
  if (!stream) return false;
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 84;
}

function paint({ animate = false, urgent = false } = {}) {
  if (!store.state || !refs.viewInner) return;
  if (!urgent && !animate) {
    const since = Date.now() - store.lastPaintAt;
    if (since < 560) {
      if (!store.paintTimer) {
        store.paintTimer = setTimeout(() => {
          store.paintTimer = null;
          requestPaint({});
        }, 570 - since);
      }
      return;
    }
  }
  if (store.paintTimer) {
    clearTimeout(store.paintTimer);
    store.paintTimer = null;
  }
  store.lastPaintAt = Date.now();

  updateShell();
  const scroll = store.resetScroll ? 0 : refs.view.scrollTop;
  store.resetScroll = false;
  const keep = captureKeep();
  const pinned = danmakuPinned();
  refs.viewInner.classList.toggle('no-anim', !animate);
  refs.viewInner.innerHTML = renderView(store.view, store.state, store.ui);
  restoreKeep(keep);
  refs.view.scrollTop = scroll;
  if (pinned) {
    const stream = refs.viewInner.querySelector('[data-autoscroll]');
    if (stream) stream.scrollTop = stream.scrollHeight;
  }
  if (animate && !reducedMotion.matches) {
    refs.viewInner.animate(
      [
        { opacity: 0.4, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' }
    );
  }
  renderChat();
}

function navigate(view) {
  const next = normalizeView(view);
  closePalette();
  closeDrawer();
  if (coachState) endCoach(true);
  if (next === store.view) {
    refs.view?.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    return;
  }
  store.view = next;
  store.resetScroll = true;
  if (readHash() !== next) history.pushState(null, '', `#${next}`);
  requestPaint({ animate: true, urgent: true });
  if (next === 'system' && !store.ui.acceptance && !store.ui.acceptanceLoading) {
    void loadAcceptance({ silent: true, focusView: false });
  }
}

function applyState(state, { urgent = true } = {}) {
  if (!state) return;
  store.state = state;
  requestPaint({ urgent });
}

function chatMessages() {
  const list = [...(store.state?.chat ?? [])];
  const pending = store.pendingUser;
  if (pending) {
    const seen = list.some(
      (message) =>
        message.role === 'user' &&
        message.text === pending.text &&
        Math.abs((message.at ?? 0) - pending.at) < 12000
    );
    if (!seen) list.push(pending);
  }
  return list;
}

function typingHtml() {
  return `<div class="chat-row">
    <span class="chat-avatar">枢</span>
    <div class="chat-body">
      <div class="chat-name">中枢 Copilot · 思考中</div>
      <div class="typing"><i></i><i></i><i></i></div>
    </div>
  </div>`;
}

function setChatMode(mode) {
  const next = mode === 'llm' ? 'llm' : 'cmd';
  if (next === store.chatMode) {
    document.getElementById('chat-input')?.focus();
    return;
  }
  store.chatMode = next;
  storage.set('nexus.copilotMode', next);
  applyChatMode();
  document.getElementById('chat-input')?.focus();
}

function applyChatMode() {
  const meta = CHAT_MODE_META[store.chatMode] ?? CHAT_MODE_META.cmd;
  document.querySelectorAll('[data-act="chat-mode"]').forEach((btn) => {
    const active = btn.dataset.mode === store.chatMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const input = document.getElementById('chat-input');
  if (input) {
    input.placeholder = meta.placeholder;
    input.setAttribute('aria-label', meta.aria);
  }
  const holder = document.getElementById('chat-suggestions');
  if (holder) holder.dataset.signature = '';
  renderChatSuggestions();
  if (store.state) {
    const activeAgents = (store.state.agents ?? []).filter((agent) => agent.status === 'active');
    setText(
      'copilot-mode',
      store.chatMode === 'llm'
        ? '大模型对话模式'
        : `${activeAgents.length}/${store.state.agents?.length ?? 0} 在线 · 直连`
    );
  }
}

function renderChatSuggestions() {
  const holder = document.getElementById('chat-suggestions');
  if (!holder) return;
  const stage = store.state?.session?.stage ?? 'prep';
  const suggestions = store.chatMode === 'llm' ? LLM_CHAT_SUGGESTIONS : CHAT_SUGGESTIONS;
  const signature = `${store.chatMode}|${stage}|${suggestions.length}`;
  if (holder.dataset.signature === signature) return;
  holder.dataset.signature = signature;
  holder.innerHTML = suggestions.map((item) => {
    const enabled = !item.stages || item.stages.includes(stage);
    return `<button class="suggestion ${enabled ? '' : 'is-disabled'}" data-act="chat-suggestion" data-message="${esc(
      item.text
    )}" ${enabled ? '' : 'disabled'} title="${esc(enabled ? '发送这条消息' : item.reason)}">${esc(
      item.text
    )}</button>`;
  }).join('');
}

function renderChat(force = false) {
  if (!refs.chatScroll) return;
  const messages = chatMessages();
  const signature = `${store.state?.chat?.length ?? 0}|${messages.at(-1)?.id ?? messages.at(-1)?.at ?? ''}|${
    store.chatSending ? 1 : 0
  }|${store.pendingUser?.text ?? ''}`;
  if (!force && signature === store.chatSignature) {
    setText('chat-state', store.chatSending ? '思考中' : '就绪');
    return;
  }
  store.chatSignature = signature;
  const pinned =
    refs.chatScroll.scrollHeight - refs.chatScroll.scrollTop - refs.chatScroll.clientHeight < 90;
  refs.chatScroll.innerHTML = chatHtml(messages, store.state) + (store.chatSending ? typingHtml() : '');
  if (pinned || force) {
    requestAnimationFrame(() => {
      refs.chatScroll.scrollTop = refs.chatScroll.scrollHeight;
    });
  }
  setText('chat-state', store.chatSending ? '思考中' : '就绪');
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(110, Math.max(24, el.scrollHeight))}px`;
}

function syncComposerState() {
  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');
  if (send) send.disabled = !input?.value.trim() || store.chatSending;
  setText('chat-state', store.chatSending ? '思考中' : '就绪');
}

async function sendChat(inputText) {
  const text = String(inputText ?? '').trim().slice(0, 400);
  if (!text) return;
  if (store.chatSending) {
    toast('Copilot 正在处理', '等这一条回复完成后再发送。', 'warn', 2400);
    return;
  }
  const input = document.getElementById('chat-input');
  const restore = input?.value ?? '';
  if (input) {
    input.value = '';
    autoGrow(input);
  }
  store.pendingUser = { id: `local-${Date.now()}`, role: 'user', text, at: Date.now() };
  store.chatSending = true;
  store.chatSignature = '';
  renderChat(true);
  syncComposerState();
  const mode = store.chatMode;
  try {
    const response = await api.chat(text, mode);
    if (response.state) applyState(response.state);
  } catch (error) {
    toastError('指令未送达', error);
    if (input && !input.value) {
      input.value = restore || text;
      autoGrow(input);
    }
  } finally {
    store.pendingUser = null;
    store.chatSending = false;
    store.chatSignature = '';
    renderChat(true);
    syncComposerState();
    requestPaint({ urgent: true });
  }
}

async function syncState({ silent = true } = {}) {
  if (store.syncInFlight) {
    store.syncAgain = true;
    return;
  }
  store.syncInFlight = true;
  try {
    const response = await api.state();
    store.state = response.state;
    requestPaint({});
  } catch (error) {
    if (!silent) toastError('状态同步失败', error);
  } finally {
    store.syncInFlight = false;
    if (store.syncAgain) {
      store.syncAgain = false;
      setTimeout(() => void syncState({ silent }), 90);
    }
  }
}

function scheduleSync(delay = 320) {
  if (store.syncTimer) return;
  store.syncTimer = setTimeout(() => {
    store.syncTimer = null;
    void syncState({ silent: true });
  }, delay);
}

function setConnected(connected) {
  if (store.connected === connected) return;
  const wasConnected = store.connected;
  store.connected = connected;
  const dot = document.getElementById('sb-dot');
  if (dot) dot.classList.toggle('warn', !connected);
  setText('sb-conn', connected ? '实时通道已连接' : '正在重连');
  if (connected) {
    if (store.everConnected && !wasConnected) {
      toast('实时通道已恢复', '黑板与消息总线重新对齐。', 'ok', 2600);
    }
    store.everConnected = true;
  } else if (wasConnected) {
    toast('实时通道断开', 'EventSource 会自动重连，状态可能短暂滞后。', 'warn', 3000);
  }
}

function connectStream() {
  if (!window.EventSource) {
    scheduleSync(1000);
    setInterval(() => void syncState({ silent: true }), 3200);
    return;
  }
  if (store.source) store.source.close();
  const source = new EventSource(EVENT_SOURCE_URL);
  store.source = source;
  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('error', () => setConnected(false));
  source.addEventListener('hello', (event) => {
    const frame = safeJson(event.data);
    if (frame?.state) {
      store.state = frame.state;
      setConnected(true);
      requestPaint({ urgent: true });
    }
  });
  EVENT_TYPES.forEach((type) => {
    source.addEventListener(type, (event) => {
      const frame = safeJson(event.data);
      handleStreamEvent(type, frame?.payload ?? frame);
    });
  });
}

function handleStreamEvent(type, payload) {
  if (!store.connected) setConnected(true);
  store.eventCount += 1;
  const state = store.state;
  if (state && payload) {
    if (type === 'metrics') {
      state.metrics = { ...state.metrics, ...payload };
      state.metricsHistory = [...(state.metricsHistory ?? []), { at: Date.now(), ...payload }].slice(-120);
    } else if (type === 'session') {
      state.session = { ...state.session, ...payload };
      if (payload.metrics) state.metrics = { ...state.metrics, ...payload.metrics };
    } else if (type === 'chat') {
      if (!state.chat?.some((message) => message.id === payload.id)) {
        state.chat = [...(state.chat ?? []), payload].slice(-40);
      }
    } else if (type === 'danmaku') {
      if (!state.danmaku?.some((item) => item.id === payload.id)) {
        state.danmaku = [...(state.danmaku ?? []), payload].slice(-60);
      }
    } else if (type === 'response') {
      if (!state.responses?.some((item) => item.id === payload.id)) {
        state.responses = [...(state.responses ?? []), payload].slice(-30);
      }
    } else if (type === 'decision') {
      if (!state.decisions?.some((item) => item.id === payload.id)) {
        state.decisions = [payload, ...(state.decisions ?? [])].slice(0, 40);
      }
    } else if (type === 'agent') {
      const index = state.agents?.findIndex((agent) => agent.id === payload.id) ?? -1;
      if (index >= 0) state.agents[index] = payload;
    } else if (type === 'plan') {
      state.plan = payload;
    } else if (type === 'blackboard') {
      state.blackboard = payload;
    } else if (type === 'cnp') {
      state.cnp = payload;
    } else if (type === 'consensus') {
      state.consensus = payload;
    } else if (type === 'incident') {
      state.incident = payload;
    } else if (type === 'coupon.issued') {
      state.coupon = payload;
    } else if (type === 'loadtest') {
      state.loadTest = payload;
      state.stressHistory = [payload, ...(state.stressHistory ?? [])].slice(0, 6);
    }
  }
  if (type === 'chat') {
    renderChat();
    scheduleSync(140);
    return;
  }
  if (
    [
      'metrics',
      'session',
      'agent',
      'danmaku',
      'response',
      'decision',
      'plan',
      'blackboard',
      'cnp',
      'consensus',
      'incident',
      'coupon.issued',
      'loadtest'
    ].includes(type)
  ) {
    requestPaint({});
  }
  scheduleSync(type === 'system.shutdown' ? 1200 : 320);
}

function openDecisionDetail(id) {
  const decision = (store.state?.decisions ?? []).find((item) => item.id === id);
  if (!decision) {
    toast('决策尚未载入', '等待状态同步后再查看这张决策卡片。', 'warn', 2600);
    return;
  }
  const info = agentInfo(store.state, decision.agent);
  const risk = riskMeta(decision.risk);
  openDrawer({
    eyebrow: `DECISION · ${risk.label}`,
    title: decision.action,
    desc: `${info.cn} · ${decision.id} · ${shortId(decision.traceId, 18)}`,
    body: decisionDetailHtml(decision, store.state)
  });
}

function openAgentDetail(id) {
  const agent = (store.state?.agents ?? []).find((item) => item.id === id || item.logicalRole === id);
  if (!agent) {
    toast('智能体不存在', '该实例可能已经下线。', 'warn', 2400);
    return;
  }
  openDrawer({
    eyebrow: `AGENT · ${agent.latin ?? agent.logicalRole.toUpperCase()}`,
    title: `${agent.name} · ${agent.title}`,
    desc: `${agent.id} · ${agent.cognition} · ${agent.status.toUpperCase()}`,
    body: agentDetailHtml(agent, store.state)
  });
}

function openToolDetail(name) {
  const tool = (store.state?.tools ?? []).find((item) => item.name === name);
  if (!tool) {
    toast('工具不存在', '注册表可能已经更新。', 'warn', 2400);
    return;
  }
  openDrawer({
    eyebrow: `MCP TOOL · ${tool.category.toUpperCase()}`,
    title: tool.name,
    desc: tool.description,
    body: toolDetailHtml(tool, store.state)
  });
}

async function openTraceDetail(id) {
  openDrawer({
    eyebrow: 'TRACE',
    title: '链路追踪',
    desc: id,
    body: '<div class="mono dim" style="font-size:9px">正在读取 span 瀑布…</div>'
  });
  try {
    const response = await api.trace(id);
    updateDrawer(traceDetailHtml(response.trace, store.state));
  } catch (error) {
    updateDrawer(`<div class="chat-notice">${esc(errorMessage(error))}</div>`);
  }
}

function openPlanDetail() {
  const plan = store.state?.plan;
  if (!plan) {
    toast('尚未生成方案', '先让策选运行一次 Plan-Execute。', 'warn', 2400);
    return;
  }
  openDrawer({
    eyebrow: `方案 · ${plan.version}`,
    title: plan.narrative?.headline ?? plan.title,
    desc: `${plan.id} · ${plan.products?.length ?? 0} 个商品 · ${plan.segments?.length ?? 0} 段排期`,
    body: planDetailHtml(plan, store.state)
  });
}

async function callTool(name) {
  const tool = (store.state?.tools ?? []).find((item) => item.name === name);
  if (!tool) return;
  const argsEl = document.querySelector('#drawer-root textarea[name="args"]');
  let args = {};
  if (argsEl?.value.trim()) {
    try {
      args = JSON.parse(argsEl.value);
    } catch (error) {
      toast('JSON 参数无效', error.message, 'danger', 4200);
      return;
    }
  }
  const resultEl = document.getElementById('tool-result');
  if (resultEl) {
    resultEl.textContent = '调用中…';
    resultEl.style.color = 'var(--muted)';
  }
  await withBusy(`tool:${name}`, async () => {
    try {
      const response = await api.callTool(name, args);
      if (resultEl && document.body.contains(resultEl)) {
        resultEl.textContent = JSON.stringify(response.result, null, 2);
        resultEl.style.color = 'var(--mint-soft)';
      }
      if (response.state) applyState(response.state);
      toast('工具调用成功', `${name} · ${fmtMs(response.result?.durationMs ?? 0)}`, 'ok', 3200);
    } catch (error) {
      const approval = error instanceof ApiError && error.code === 'APPROVAL_REQUIRED';
      if (resultEl && document.body.contains(resultEl)) {
        resultEl.textContent = `${errorMessage(error)}${error.code ? `\n\ncode: ${error.code}` : ''}`;
        resultEl.style.color = 'var(--danger)';
      }
      toast(approval ? '需要共识审批' : '工具调用失败', approval ? '高风险工具必须携带有效审批 ID，先触发一次共识投票。' : errorMessage(error), 'warn', 5000);
    }
  });
}

async function removeTool(name) {
  const tool = (store.state?.tools ?? []).find((item) => item.name === name);
  if (!tool) return;
  if (tool.source !== 'hotplug') {
    toast('内置工具不可卸载', '只有运行时热插拔的工具允许移除。', 'warn', 3200);
    return;
  }
  const ok = await confirmDialog({
    title: '卸载热插拔工具？',
    desc: `${name} 将立即从 MCP 注册表移除，所有 Actor 不再能调用它。`,
    confirmLabel: '卸载工具',
    tone: 'danger'
  });
  if (!ok) return;
  await withBusy(`tool-remove:${name}`, async () => {
    try {
      const response = await api.removeTool(name);
      if (response.state) applyState(response.state);
      closeDrawer();
      toast('工具已卸载', `${name} 已离开注册表。`, 'ok', 3000);
    } catch (error) {
      toastError('卸载失败', error);
    }
  });
}

async function runPrepare() {
  await withBusy('prepare', async () => {
    try {
      const response = await api.prepare();
      applyState(response.state);
      const plan = response.result?.plan;
      const winner = response.result?.contract?.winner;
      toast(
        '直播方案已发布',
        `${plan?.version ?? ''} · ${plan?.products?.length ?? 0} 个商品 · 招标赢家 ${
          winner ? agentInfo(store.state, winner).cn : '中枢'
        }`,
        'ok',
        5200
      );
    } catch (error) {
      toastError('生成方案失败', error);
    }
  });
}

async function runLiveStart() {
  await withBusy('live-start', async () => {
    try {
      const response = await api.startLive();
      applyState(response.state);
      navigate('live');
      toast('直播已开始', `${fmtNum(response.state.metrics?.viewers ?? 0)} 人在线 · 自动弹幕与成交仿真已启动`, 'ok', 3600);
    } catch (error) {
      toastError('开播失败', error);
    }
  });
}

async function runLivePause() {
  await withBusy('live-pause', async () => {
    try {
      const response = await api.pauseLive();
      applyState(response.state);
      toast('直播已暂停', '弹幕批次停止消费，当前队列保留。', 'warn', 3000);
    } catch (error) {
      toastError('暂停失败', error);
    }
  });
}

async function runLiveResume() {
  await withBusy('live-resume', async () => {
    try {
      const response = await api.resumeLive();
      applyState(response.state);
      toast('直播已恢复', '流式引擎重新开始消费弹幕。', 'ok', 3000);
    } catch (error) {
      toastError('恢复失败', error);
    }
  });
}

async function runLiveStop() {
  const ok = await confirmDialog({
    title: '结束本场直播？',
    desc: '实时链路会停止，弹幕无法继续注入。结束后可立即运行本场复盘。',
    confirmLabel: '结束直播',
    tone: 'danger'
  });
  if (!ok) return;
  await withBusy('live-stop', async () => {
    try {
      const response = await api.stopLive();
      applyState(response.state);
      toast('直播已结束', '实时链路停止，等待复盘。', 'ok', 3200);
    } catch (error) {
      toastError('结束直播失败', error);
    }
  });
}

async function runReview() {
  await withBusy('review', async () => {
    try {
      const response = await api.review();
      applyState(response.state);
      navigate('review');
      const report = response.result?.report;
      const att = report?.causal?.att ?? 0;
      const pValue = report?.causal?.pValue;
      toast(
        '复盘完成',
        `ATT ${att >= 0 ? '+' : ''}${(att * 100).toFixed(2)}pp · p=${pValue} · 结论已写回记忆`,
        att >= 0 ? 'ok' : 'warn',
        6200
      );
    } catch (error) {
      toastError('复盘失败', error);
    }
  });
}

async function runEndAndReview() {
  const ok = await confirmDialog({
    title: '结束直播并进入复盘？',
    desc: '实时链路会停止，随后 Analyst 用完整样本估计 ATT，并把结论写回情景记忆。',
    confirmLabel: '结束并复盘',
    tone: 'danger'
  });
  if (!ok) return;
  await withBusy('end-review', async () => {
    try {
      const stopped = await api.stopLive();
      applyState(stopped.state);
      const response = await api.review();
      applyState(response.state);
      navigate('review');
      const report = response.result?.report;
      const att = report?.causal?.att ?? 0;
      toast(
        '直播已结束 · 复盘完成',
        `ATT ${att >= 0 ? '+' : ''}${(att * 100).toFixed(2)}pp · p=${report?.causal?.pValue ?? '—'} · 结论已写回记忆`,
        att >= 0 ? 'ok' : 'warn',
        6200
      );
    } catch (error) {
      toastError('结束并复盘失败', error);
    }
  });
}

async function runScenario(type) {
  await withBusy(`scenario:${type}`, async () => {
    try {
      const response = await api.scenario(type);
      applyState(response.state);
      navigate('live');
      const result = response.result ?? {};
      if (type === 'negative') {
        toast(
          '舆情演练已处置',
          `${result.incident?.count ?? 3} 条负面 · 共识权重 ${result.incident?.voteSummary?.weight ?? 0} / ${
            result.incident?.voteSummary?.threshold ?? 2.4
          } · ${result.incident?.status ?? '已执行'}`,
          'warn',
          6000
        );
      } else if (type === 'extreme') {
        const violations = result.result?.result?.response?.guardrail?.violations?.length ?? 0;
        toast('合规探针已拦截', `${violations} 处极限词被强制改写，没有进入直播间。`, 'warn', 6000);
      } else if (type === 'coupon') {
        toast('发券共识通过', response.state.coupon?.label ?? '优惠券已发放', 'ok', 4200);
      } else if (type === 'price') {
        toast('价格红线已拦截', result.veto?.reason ?? '合规一票否决，改价进入人工复核。', 'danger', 6200);
      } else if (type === 'surge') {
        const p99 = response.state.metrics?.p99 ?? 0;
        toast(
          '弹幕洪峰已消化',
          `P99 ${fmtMs(p99)} · 累计 ${fmtNum(response.state.metrics?.comments ?? 0)} 条弹幕`,
          p99 <= (response.state.metrics?.latencyTarget ?? 500) ? 'ok' : 'warn',
          4200
        );
      }
    } catch (error) {
      toastError('场景执行失败', error);
    }
  });
}

async function runStress(events) {
  const size = Number(events) || 800;
  await withBusy(`stress:${size}`, async () => {
    try {
      const response = await api.stress(size);
      store.ui.stressResult = response.result;
      applyState(response.state);
      if (store.view !== 'system') navigate('system');
      else requestPaint({ urgent: true });
      toast(
        '压测完成',
        `P99 ${response.result.p99}ms · ${fmtNum(response.result.throughput)}/s · ${
          response.result.passed ? '达到目标' : '未达目标'
        }`,
        response.result.passed ? 'ok' : 'warn',
        5200
      );
    } catch (error) {
      toastError('压测失败', error);
    }
  });
}

async function runFault(agent, mode) {
  await withBusy(`fault:${agent}`, async () => {
    try {
      const response = await api.fault(agent, mode);
      applyState(response.state);
      const result = response.result;
      if (mode === 'offline') {
        toast(
          '故障注入完成',
          result.replica ? `${agent} 下线 · ${result.replica} 自动接管，业务未中断` : `${agent} 下线 · 无副本，任务将升级人工`,
          result.replica ? 'ok' : 'warn',
          5200
        );
      } else {
        toast('实例已恢复', `${result.active?.join('、') ?? agent} 回到 ACTIVE`, 'ok', 3200);
      }
    } catch (error) {
      toastError('故障注入失败', error);
    }
  });
}

async function runRestoreAll() {
  await withBusy('restore-all', async () => {
    try {
      let state = store.state;
      for (const agent of ['controller', 'speaker', 'selector', 'analyst']) {
        const response = await api.fault(agent, 'restore');
        state = response.state;
      }
      applyState(state);
      toast('全部实例已恢复', '主实例 ACTIVE，副本回到 STANDBY。', 'ok', 3600);
    } catch (error) {
      toastError('恢复失败', error);
    }
  });
}

async function loadAcceptance({ force = false, silent = false, focusView = true } = {}) {
  if (store.ui.acceptanceLoading) return;
  if (store.ui.acceptance && !force) {
    if (focusView && store.view !== 'system') navigate('system');
    return;
  }
  store.ui.acceptanceLoading = true;
  setProgress(true);
  if (focusView && store.view !== 'system') navigate('system');
  else if (store.view === 'system') requestPaint({ urgent: true });
  try {
    const response = await api.acceptance(force);
    store.ui.acceptance = response.report;
    const summary = response.report.summary ?? {};
    if (!silent) {
      toast(
        '验收完成',
        `${response.report.verdict} · ${response.report.score} 分 · ${summary.pass} 通过 / ${summary.warn} 待验证 / ${summary.fail} 失败`,
        summary.fail ? 'warn' : 'ok',
        6200
      );
    }
  } catch (error) {
    toastError('验收运行失败', error);
  } finally {
    store.ui.acceptanceLoading = false;
    if (!store.busy.size) setProgress(false);
    if (store.view === 'system') requestPaint({ urgent: true });
  }
}

async function manualRefresh() {
  await withBusy('refresh', async () => {
    try {
      const response = await api.state();
      applyState(response.state);
      toast('状态已同步', '黑板与消息总线已对齐最新版本。', 'ok', 2200);
    } catch (error) {
      toastError('状态同步失败', error);
    }
  });
}

async function runReset() {
  const ok = await confirmDialog({
    title: '重置当前演示？',
    desc: '会话、弹幕、决策与工具热插拔状态会回到初始种子。验收记录与本地界面偏好保留。',
    confirmLabel: '重置演示',
    tone: 'danger'
  });
  if (!ok) return;
  await withBusy('reset', async () => {
    try {
      const response = await api.reset();
      store.ui.decisionSearch = '';
      store.ui.decisionAgent = 'all';
      store.ui.decisionRisk = 'all';
      store.ui.stressResult = null;
      store.ui.acceptance = null;
      store.pendingUser = null;
      store.chatSending = false;
      applyState(response.state);
      navigate('overview');
      toast('演示已重置', '可以重新生成方案、开播并复现全部协同链路。', 'ok', 3600);
    } catch (error) {
      toastError('重置失败', error);
    }
  });
}

const DEMO_STEP_MS = 3000;

const DEMO_STEPS = [
  {
    key: 'reset',
    label: '重置演示环境',
    detail: '回到初始种子，保证剧本可重复',
    run: async () => {
      const response = await api.reset();
      store.ui.decisionSearch = '';
      store.ui.decisionAgent = 'all';
      store.ui.decisionRisk = 'all';
      store.ui.stressResult = null;
      store.pendingUser = null;
      store.chatSending = false;
      applyState(response.state);
      navigate('overview');
    }
  },
  {
    key: 'prepare',
    label: '生成直播方案',
    detail: '合同网招标 + Plan-Execute 出方案',
    run: async () => {
      const response = await api.prepare();
      applyState(response.state);
    }
  },
  {
    key: 'live',
    label: '开始直播',
    detail: '自动弹幕与成交仿真同时启动',
    run: async () => {
      const response = await api.startLive();
      applyState(response.state);
      navigate('live');
    }
  },
  {
    key: 'danmaku',
    label: '注入三条真实弹幕',
    detail: '场控 ReAct 实时回应并留痕',
    run: async () => {
      const lines = ['这款普洱熟茶多少钱？', '有买二送一的活动吗？', '上次买的很好，什么时候补货？'];
      let last = null;
      for (const text of lines) {
        last = await api.danmaku(text);
        applyState(last.state);
        await sleep(420);
      }
      navigate('live');
    }
  },
  {
    key: 'fault',
    label: '故障切换：场控下线',
    detail: '热备副本自动接管，业务不中断',
    run: async () => {
      const response = await api.fault('controller', 'offline');
      applyState(response.state);
      navigate('agents');
    }
  },
  {
    key: 'restore',
    label: '恢复主实例',
    detail: '副本回到 STANDBY，主实例 ACTIVE',
    run: async () => {
      const response = await api.fault('controller', 'restore');
      applyState(response.state);
    }
  },
  {
    key: 'stop',
    label: '结束直播',
    detail: '实时链路收口，弹幕停止消费',
    run: async () => {
      const response = await api.stopLive();
      applyState(response.state);
      navigate('live');
    }
  },
  {
    key: 'review',
    label: '生成复盘报告',
    detail: 'ATT + Reflexion，结论写回情景记忆',
    run: async () => {
      const response = await api.review();
      applyState(response.state);
      navigate('review');
    }
  }
];

let demoRun = null;

function renderDemoHud() {
  const rootEl = document.getElementById('demo-root');
  if (!rootEl || !demoRun) return;
  const done = demoRun.steps.filter((step) => step.status === 'done').length;
  const total = demoRun.steps.length;
  const active = demoRun.steps.find((step) => step.status === 'running');
  const failed = demoRun.steps.some((step) => step.status === 'failed');
  rootEl.innerHTML = `<section class="demo-hud ${demoRun.finished ? 'is-done' : ''}" role="status" aria-live="polite">
    <div class="demo-hud-head">
      <span class="demo-hud-kicker"><i></i>${demoRun.finished ? '剧本已完成' : '一键演示 · 全流程自动化'}</span>
      ${
        demoRun.running
          ? `<button class="demo-hud-stop" data-act="demo-stop">停止</button>`
          : `<button class="demo-hud-stop" data-act="demo-close">关闭</button>`
      }
    </div>
    <div class="demo-hud-title">${
      failed ? '剧本中断，请检查后端日志' : active ? active.label : demoRun.finished ? '五个阶段全部跑通' : '准备中'
    }</div>
    <div class="demo-hud-sub">${esc(active?.detail ?? (demoRun.finished ? '产出一份可直接展示的复盘报告' : ''))}</div>
    <div class="demo-hud-meter"><i style="width:${Math.round((done / total) * 100)}%"></i></div>
    <div class="demo-hud-count"><span>${done} / ${total} 步</span><span>${Math.round((done / total) * 100)}%</span></div>
    <ol class="demo-hud-steps">
      ${demoRun.steps
        .map(
          (step, index) => `<li class="${step.status}">
            <span class="demo-step-node">${step.status === 'done' ? icon('check', 10) : index + 1}</span>
            <b>${esc(step.label)}</b>
            <small>${esc(step.detail)}</small>
          </li>`
        )
        .join('')}
    </ol>
  </section>`;
  rootEl.classList.add('open');
  const trigger = document.querySelector('#demo-trigger span');
  if (trigger) {
    trigger.textContent = demoRun.running ? `演示中 ${Math.min(done + 1, total)}/${total}` : '一键演示';
  }
}

function closeDemoHud() {
  const rootEl = document.getElementById('demo-root');
  if (!rootEl) return;
  rootEl.classList.remove('open');
  setTimeout(() => {
    if (!rootEl.classList.contains('open')) rootEl.innerHTML = '';
  }, 320);
  const trigger = document.querySelector('#demo-trigger span');
  if (trigger) trigger.textContent = '一键演示';
}

function stopDemo(message = '演示已停止') {
  if (!demoRun?.running) {
    closeDemoHud();
    return;
  }
  demoRun.cancelled = true;
  demoRun.running = false;
  demoRun.steps.forEach((step) => {
    if (step.status === 'running' || step.status === 'pending') step.status = 'skipped';
  });
  renderDemoHud();
  toast(message, '已保留当前进度，可以随时重新开始。', 'warn', 3200);
  setTimeout(closeDemoHud, 2600);
}

async function runDemo() {
  if (demoRun?.running) {
    toast('演示正在运行', '等待当前剧本结束，或点演示面板上的停止。', 'warn', 2600);
    return;
  }
  closeDrawer();
  closeFunctionMap();
  demoRun = {
    running: true,
    finished: false,
    cancelled: false,
    steps: DEMO_STEPS.map((step) => ({ ...step, status: 'pending' })),
    index: 0
  };
  renderDemoHud();
  document.body.classList.add('demo-running');
  setProgress(true);
  try {
    for (let index = 0; index < demoRun.steps.length; index += 1) {
      if (demoRun.cancelled) break;
      const step = demoRun.steps[index];
      demoRun.index = index;
      step.status = 'running';
      renderDemoHud();
      await step.run();
      step.status = 'done';
      renderDemoHud();
      await sleep(step.hold ?? DEMO_STEP_MS);
    }
    if (!demoRun.cancelled) {
      demoRun.running = false;
      demoRun.finished = true;
      renderDemoHud();
      toast('一键演示完成', '方案 → 开播 → 弹幕 → 故障切换 → 下播 → 复盘，全链路已跑通。', 'ok', 6000);
      setTimeout(closeDemoHud, 9000);
    }
  } catch (error) {
    const step = demoRun.steps[demoRun.index];
    if (step) step.status = 'failed';
    demoRun.running = false;
    renderDemoHud();
    toastError(`演示中断 · ${step?.label ?? '未知步骤'}`, error);
  } finally {
    document.body.classList.remove('demo-running');
    if (!store.busy.size) setProgress(false);
    const trigger = document.querySelector('#demo-trigger span');
    if (trigger && !demoRun?.running) trigger.textContent = '一键演示';
  }
}

const FUNCTION_MAP = [
  {
    view: 'overview',
    label: '本场总览',
    role: '主流程',
    desc: '判断“现在该做什么”，并推进阶段。',
    items: [
      ['五阶段流程条', '筹备 → 开播 → 实时互动 → 下播 → 复盘，可点击直达'],
      ['阶段主按钮', '随阶段切换：生成方案 / 开始直播 / 结束直播并复盘'],
      ['四个核心指标', 'GMV、订单、在线观众、流式 P99 与预算对比'],
      ['一键演示', '按剧本自动跑完整场直播，答辩免手动']
    ]
  },
  {
    view: 'agents',
    label: '智能体',
    role: '协同',
    desc: '看清四个 Actor 的职责、心跳与热备接管。',
    items: [
      ['四个对等 Actor', '策选、场控、言枢、观澜 各自持有工具与记忆'],
      ['热备副本', '主实例下线时副本自动接管，业务不中断'],
      ['合同网分工', 'CFP → PROPOSE → AWARD 产生方案'],
      ['关系拓扑', 'A2A 链路与会话上下文一屏可见']
    ]
  },
  {
    view: 'live',
    label: '直播中控',
    role: '实时',
    desc: '发弹幕与舆情演练，观察 ReAct 实时决策。',
    items: [
      ['弹幕注入', '真实文本进入流式管线，P99 实时更新'],
      ['舆情演练', '负面、极限词、击穿底价、弹幕洪峰'],
      ['实时决策流', '每条回应都带风险级别与 trace'],
      ['合规前置', '输出前改写，红线动作直接拦截']
    ]
  },
  {
    view: 'decisions',
    label: '决策追溯',
    role: '证据',
    desc: '按风险或智能体筛选，回溯 trace 与证据。',
    items: [
      ['决策卡片', '动作、置信度、风险、执行状态一屏读完'],
      ['trace 回溯', 'A2A 信封、共识票型与工具调用链'],
      ['风险筛选', '只看红线与高风险动作'],
      ['人工兜底', '升级工单与接管入口']
    ]
  },
  {
    view: 'review',
    label: '复盘',
    role: '学习',
    desc: '看因果归因与下一场可直接执行的动作。',
    items: [
      ['ATT 与置信区间', '发券等动作的因果效应与显著性'],
      ['Reflexion', '把成功与失败写成可复用经验'],
      ['策略写回', '下一场话术、节奏与选品建议'],
      ['实验账本', '本场对照与历史复盘记录']
    ]
  },
  {
    view: 'protocol',
    label: '工具与协议',
    role: '底座',
    desc: '挂载 MCP 工具、查看 A2A 信封与黑板版本。',
    items: [
      ['MCP 注册表', '18+ 工具自描述，风险分级与审批'],
      ['工具热插拔', '运行时挂载 / 卸载，无需重启'],
      ['A2A 信封', 'trace_id 强制，消息可改投'],
      ['黑板书', '按版本收敛共享事实']
    ]
  },
  {
    view: 'system',
    label: '系统验收',
    role: '验收',
    desc: '跑 20 项探针与压测，现场验证稳定性。',
    items: [
      ['20 项验收探针', '协议、协同、合规、时延逐项打分'],
      ['压测', '800 条弹幕洪峰，P99 与吞吐达标'],
      ['故障演练', '实例下线、副本接管、全员恢复'],
      ['运行环境', '版本、架构与数据口径说明']
    ]
  }
];

async function openLlmConfig() {
  closeDrawer();
  openDrawer({
    eyebrow: '大模型配置 · LLM',
    title: '接入远端大模型',
    desc: '配置 DeepSeek（兼容 OpenAI 协议）API Key，远端优先、本地规则兜底，断网自动降级。',
    body: `<div class="llm-config-loading">正在读取当前配置…</div>`
  });
  let config;
  try {
    const resp = await api.getLlmConfig();
    config = resp.config;
  } catch (error) {
    updateDrawer(`<div class="empty-state"><p>${esc(error.message ?? '读取配置失败')}</p></div>`);
    return;
  }
  const modeLabel = config.offline ? '本地规则引擎（离线）' : `远端优先 · ${config.model}`;
  const keyDisplay = config.apiKeyConfigured
    ? `<span class="key-masked">${esc(config.apiKeyMasked)}</span>`
    : '<span class="key-empty">未配置</span>';
  const body = `
    <div class="llm-config">
      <div class="llm-status">
        <div class="llm-status-row">
          <span class="llm-label">当前模式</span>
          <span class="llm-mode ${config.offline ? 'offline' : 'online'}">${esc(modeLabel)}</span>
        </div>
        <div class="llm-status-row">
          <span class="llm-label">API Key</span>
          ${keyDisplay}
        </div>
        <div class="llm-status-row">
          <span class="llm-label">远端调用</span>
          <span>${config.remoteCallCount} 次</span>
        </div>
        <div class="llm-status-row">
          <span class="llm-label">降级次数</span>
          <span>${config.fallbackCount} 次</span>
        </div>
      </div>

      <form class="llm-form" id="llm-config-form">
        <label class="field">
          <span>API Key</span>
          <input type="password" name="apiKey" placeholder="sk-…（留空则清除并切回本地模式）" autocomplete="off" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>Base URL</span>
            <input type="text" name="baseUrl" value="${esc(config.baseUrl)}" placeholder="https://api.deepseek.com" />
          </label>
          <label class="field field-small">
            <span>模型</span>
            <input type="text" name="model" value="${esc(config.model)}" placeholder="deepseek-chat" />
          </label>
          <label class="field field-tiny">
            <span>超时(秒)</span>
            <input type="number" name="timeout" value="${config.timeout}" min="1" step="1" />
          </label>
        </div>
        <label class="field field-check">
          <input type="checkbox" name="offline" ${config.offline ? 'checked' : ''} />
          <span>强制离线模式（仅本地规则引擎）</span>
        </label>
        <div class="form-actions">
          <button type="button" class="btn ghost" data-act="close-drawer">取消</button>
          <button type="submit" class="btn primary">保存配置</button>
        </div>
      </form>
    </div>`;
  updateDrawer(body);

  const form = document.getElementById('llm-config-form');
  if (!form) return;
  const apiKeyInput = form.querySelector('input[name="apiKey"]');
  const offlineCheckbox = form.querySelector('input[name="offline"]');
  // 输入 API Key 时自动取消「强制离线」勾选，避免用户填了 Key 却仍走本地
  if (apiKeyInput && offlineCheckbox) {
    apiKeyInput.addEventListener('input', () => {
      if (apiKeyInput.value.trim()) offlineCheckbox.checked = false;
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      apiKey: String(data.get('apiKey') ?? '').trim(),
      baseUrl: String(data.get('baseUrl') ?? '').trim(),
      model: String(data.get('model') ?? '').trim(),
      timeout: Number(data.get('timeout') ?? 15),
      offline: form.offline.checked
    };
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = '保存中…';
    submitBtn.disabled = true;
    try {
      const resp = await api.updateLlmConfig(payload);
      const saved = resp.config;
      toast('配置已保存', saved.offline ? '已切换到本地规则引擎' : `已启用远端模型 ${saved.model}`);
      closeDrawer();
    } catch (error) {
      toast('保存失败', error.message ?? '请重试', 'danger');
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  const closeBtn = document.querySelector('#llm-config-form [data-act="close-drawer"]');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
}

function openFunctionMap() {
  const rootEl = document.getElementById('map-root');
  if (!rootEl) return;
  closeDrawer();
  rootEl.innerHTML = `<div class="map-backdrop" data-act="map-close"></div>
    <section class="map-card" role="dialog" aria-modal="true" aria-label="功能地图">
      <header class="map-head">
        <div>
          <div class="kicker">功能地图 · 七块工作区</div>
          <h2>每个能力，都在一句话说得清的位置</h2>
          <p>按“我要做什么”选工作区；答辩时也可以逐条对照。</p>
        </div>
        <button class="map-close" data-act="map-close" aria-label="关闭">${icon('x', 16)}</button>
      </header>
      <div class="map-grid">
        ${FUNCTION_MAP.map(
          (group) => `<article class="map-view">
            <div class="map-view-head">
              <span class="map-role">${esc(group.role)}</span>
              <b>${esc(group.label)}</b>
              <button class="map-go" data-act="navigate" data-view="${group.view}">去这里 ${icon('arrowRight', 11)}</button>
            </div>
            <p>${esc(group.desc)}</p>
            <ul>${group.items
              .map(([name, detail]) => `<li><b>${esc(name)}</b><small>${esc(detail)}</small></li>`)
              .join('')}</ul>
          </article>`
        ).join('')}
      </div>
      <footer class="map-foot">
        <div><span class="map-foot-kicker">答辩动线</span><span>① 一键演示跑全流程</span><span>② 系统验收跑 20 项探针</span><span>③ ⌘K 或功能地图定位能力</span></div>
        <button class="btn ghost sm" data-act="map-close">知道了</button>
      </footer>
    </section>`;
  rootEl.classList.add('open');
  rootEl.setAttribute('aria-hidden', 'false');
}

function closeFunctionMap() {
  const rootEl = document.getElementById('map-root');
  if (!rootEl || !rootEl.classList.contains('open')) return;
  rootEl.classList.remove('open');
  rootEl.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (!rootEl.classList.contains('open')) rootEl.innerHTML = '';
  }, 260);
}

const COACH_KEY = 'nexus.coach.v1';
const COACH_STEPS = [
  {
    selector: '.rail-nav',
    placement: 'right',
    title: '左边是工作区，每个都有一句说明',
    desc: '按“总览 → 智能体 → 直播 → 决策 → 复盘”的顺序走，就能跑完一整场直播；后两块是工具与验收。'
  },
  {
    selector: '.flow-bar',
    placement: 'bottom',
    title: '顶部这条，是整场直播的主线',
    desc: '筹备 → 开播 → 实时互动 → 下播 → 复盘。当前阶段高亮，已完成打勾，点任意一段直达对应操作。'
  },
  {
    selector: '.copilot',
    placement: 'left',
    title: '右边 Copilot，用一句话执行同样的动作',
    desc: '快捷指令会随阶段启用或置灰；也可以直接说“开始直播”或“复盘并解释发券效果”。',
    before: () => {
      if (!copilotIsOpen()) setCopilot(true, false);
    }
  }
];

let coachState = null;

function startCoach() {
  if (coachState) return;
  if (new URLSearchParams(window.location.search).has('qa')) return;
  if (storage.get(COACH_KEY) === 'done') return;
  if (window.matchMedia('(max-width: 1080px)').matches) return;
  if (!refs.shell) return;
  coachState = { index: 0 };
  renderCoach();
}

function renderCoach() {
  const rootEl = document.getElementById('coach-root');
  if (!rootEl || !coachState) return;
  const step = COACH_STEPS[coachState.index];
  if (!step) {
    endCoach(true);
    return;
  }
  if (step.before) step.before();
  const target = document.querySelector(step.selector);
  if (!target) {
    coachState.index += 1;
    renderCoach();
    return;
  }
  target.scrollIntoView({ block: 'nearest' });
  const rect = target.getBoundingClientRect();
  const pad = 9;
  const cardWidth = 326;
  const cardHeight = 188;
  let left = rect.right + 18;
  let top = Math.max(88, Math.min(rect.top + 12, window.innerHeight - cardHeight - 24));
  if (step.placement === 'bottom') {
    left = Math.max(16, Math.min(rect.left + rect.width / 2 - cardWidth / 2, window.innerWidth - cardWidth - 16));
    top = rect.bottom + 16;
    if (top + cardHeight > window.innerHeight - 20) top = Math.max(88, rect.top - cardHeight - 16);
  } else if (step.placement === 'left') {
    left = Math.max(16, rect.left - cardWidth - 18);
    top = Math.max(88, Math.min(rect.top + 24, window.innerHeight - cardHeight - 24));
  }
  left = Math.max(16, Math.min(left, window.innerWidth - cardWidth - 16));
  rootEl.innerHTML = `<div class="coach-spot" style="top:${rect.top - pad}px;left:${rect.left - pad}px;width:${
    rect.width + pad * 2
  }px;height:${rect.height + pad * 2}px"></div>
    <section class="coach-card" style="top:${top}px;left:${left}px;width:${cardWidth}px" role="dialog" aria-label="快速上手引导">
      <div class="coach-kicker">快速上手 · ${coachState.index + 1} / ${COACH_STEPS.length}</div>
      <h3>${esc(step.title)}</h3>
      <p>${esc(step.desc)}</p>
      <div class="coach-foot">
        <div class="coach-dots">${COACH_STEPS.map(
          (_, index) => `<i class="${index === coachState.index ? 'on' : ''}"></i>`
        ).join('')}</div>
        <div class="coach-actions">
          <button class="btn ghost sm" data-coach="skip">跳过</button>
          <button class="btn primary sm" data-coach="next">${
            coachState.index === COACH_STEPS.length - 1 ? '开始使用' : '下一步'
          }</button>
        </div>
      </div>
    </section>`;
  rootEl.classList.add('open');
}

function coachNext() {
  if (!coachState) return;
  coachState.index += 1;
  if (coachState.index >= COACH_STEPS.length) {
    endCoach(true);
    toast('引导完成', '以后可以从顶部「功能地图」随时回看全部能力。', 'ok', 4000);
    return;
  }
  renderCoach();
}

function endCoach(save = true) {
  const rootEl = document.getElementById('coach-root');
  if (rootEl) {
    rootEl.classList.remove('open');
    rootEl.innerHTML = '';
  }
  coachState = null;
  if (save) storage.set(COACH_KEY, 'done');
}

async function submitDanmaku(form) {
  const input = form.querySelector('input[name="text"]');
  const text = input?.value.trim();
  if (!text) {
    input?.focus();
    return;
  }
  if (input) input.value = '';
  await withBusy('danmaku', async () => {
    try {
      const response = await api.danmaku(text);
      applyState(response.state);
      if (input) input.focus();
      const payload = response.result;
      if (payload?.dropped) {
        toast('弹幕被降级', '当前处于背压保护，低价值弹幕优先丢弃。', 'warn', 2600);
        return;
      }
      const reply = payload?.result?.response;
      if (reply) {
        toast(
          `场控回应 · ${INTENT_TEXT[reply.intent] ?? reply.intent}`,
          `${reply.status === 'executed' ? '已执行' : '已护栏'} · ${fmtMs(payload.latencyMs ?? reply.latencyMs)}`,
          reply.risk === 'high' ? 'warn' : 'ok',
          3000
        );
      }
    } catch (error) {
      if (input && !input.value) input.value = text;
      toastError('弹幕注入失败', error);
    }
  });
}

async function submitHotplug(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.name) {
    form.elements.namedItem('name')?.focus();
    toast('缺少工具名', '按反向域名格式填写，例如 market.compare。', 'warn', 3000);
    return;
  }
  await withBusy('hotplug', async () => {
    try {
      const response = await api.hotplug(data);
      for (const key of ['name', 'description']) {
        const field = form.elements.namedItem(key);
        if (field) field.value = '';
      }
      applyState(response.state);
      toast('工具已挂载', `${response.spec.name} · ${response.spec.riskLevel} · runtime`, 'ok', 4200);
    } catch (error) {
      toastError('工具挂载失败', error);
    }
  });
}

function fillHotplugPreset(key) {
  const preset = HOTPLUG_PRESETS[key];
  const form = document.querySelector('[data-form="hotplug"]');
  if (!preset || !form) return;
  for (const [name, value] of Object.entries(preset)) {
    const field = form.elements.namedItem(name);
    if (field) field.value = value;
  }
  form.elements.namedItem('name')?.focus();
  toast('示例已填入', '可修改工具名与描述后再挂载。', 'ok', 2200);
}

function handleChatAction(trigger) {
  const kind = trigger.dataset.kind;
  if (kind === 'navigate') {
    navigate(trigger.dataset.view);
    return;
  }
  if (kind === 'chat') {
    void sendChat(trigger.dataset.message);
    return;
  }
  if (kind === 'api') {
    const path = trigger.dataset.path;
    if (path === '/api/live/start') void runLiveStart();
    return;
  }
  if (kind === 'llm-config') {
    openLlmConfig();
  }
}

const actions = {
  navigate: (trigger) => {
    closeFunctionMap();
    navigate(trigger.dataset.view);
  },
  palette: () => openPalette(),
  'toggle-copilot': () => toggleCopilot(),
  refresh: () => manualRefresh(),
  prepare: () => runPrepare(),
  'live-start': () => runLiveStart(),
  'live-pause': () => runLivePause(),
  'live-resume': () => runLiveResume(),
  'live-stop': () => runLiveStop(),
  'end-review': () => runEndAndReview(),
  review: () => runReview(),
  demo: () => runDemo(),
  'demo-stop': () => stopDemo('演示已手动停止'),
  'demo-close': () => closeDemoHud(),
  'function-map': () => openFunctionMap(),
  'map-close': () => closeFunctionMap(),
  'llm-config': () => openLlmConfig(),
  'chat-mode': (trigger) => setChatMode(trigger.dataset.mode),
  'decision-clear': () => {
    store.ui.decisionSearch = '';
    store.ui.decisionAgent = 'all';
    store.ui.decisionRisk = 'all';
    requestPaint({ urgent: true });
  },
  scenario: (trigger) => runScenario(trigger.dataset.scenario),
  stress: (trigger) => runStress(Number(trigger.dataset.events) || 800),
  fault: (trigger) => runFault(trigger.dataset.agent, trigger.dataset.mode || 'offline'),
  'restore-all': () => runRestoreAll(),
  decision: (trigger) => openDecisionDetail(trigger.dataset.decision),
  trace: (trigger) => openTraceDetail(trigger.dataset.trace),
  agent: (trigger) => openAgentDetail(trigger.dataset.agent),
  tool: (trigger) => openToolDetail(trigger.dataset.tool),
  plan: () => openPlanDetail(),
  'tool-call': (trigger) => callTool(trigger.dataset.tool),
  'tool-remove': (trigger) => removeTool(trigger.dataset.tool),
  'hotplug-preset': (trigger) => fillHotplugPreset(trigger.dataset.preset),
  'decision-risk': (trigger) => {
    store.ui.decisionRisk = trigger.dataset.risk || 'all';
    requestPaint({ urgent: true });
  },
  acceptance: (trigger) => loadAcceptance({ force: trigger.dataset.force === '1' }),
  reset: () => runReset(),
  'chat-action': (trigger) => handleChatAction(trigger),
  'chat-suggestion': (trigger) => sendChat(trigger.dataset.message)
};

async function onClick(event) {
  const paletteItem = event.target.closest('[data-palette-index]');
  if (paletteItem) {
    event.preventDefault();
    executePalette(Number(paletteItem.dataset.paletteIndex));
    return;
  }
  if (event.target.closest('#palette-root')) return;
  const trigger = event.target.closest('[data-act]');
  if (!trigger) return;
  const act = trigger.dataset.act;
  if (IGNORE_CLICKS.has(act)) return;
  event.preventDefault();
  const action = actions[act];
  if (!action) return;
  await action(trigger);
}

async function onSubmit(event) {
  const form = event.target.closest('form');
  if (!form) return;
  if (form.dataset.form === 'danmaku') {
    event.preventDefault();
    await submitDanmaku(form);
    return;
  }
  if (form.dataset.form === 'hotplug') {
    event.preventDefault();
    await submitHotplug(form);
    return;
  }
  if (form.dataset.form === 'chat') {
    event.preventDefault();
    await sendChat(document.getElementById('chat-input')?.value);
  }
}

function onInput(event) {
  const el = event.target;
  if (el.matches('[data-act="decision-search"]')) {
    store.ui.decisionSearch = el.value;
    if (store.searchTimer) clearTimeout(store.searchTimer);
    store.searchTimer = setTimeout(() => requestPaint({ urgent: true }), 130);
  }
}

function onChange(event) {
  const el = event.target;
  if (el.matches('[data-act="decision-agent"]')) {
    store.ui.decisionAgent = el.value;
    requestPaint({ urgent: true });
  }
}

function onHashChange() {
  const next = readHash();
  if (next === store.view) return;
  store.view = next;
  store.resetScroll = true;
  closePalette();
  closeDrawer();
  requestPaint({ animate: true, urgent: true });
  if (next === 'system' && !store.ui.acceptance && !store.ui.acceptanceLoading) {
    void loadAcceptance({ silent: true, focusView: false });
  }
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    if (coachState) {
      endCoach(true);
      return;
    }
    if (document.getElementById('map-root')?.classList.contains('open')) {
      closeFunctionMap();
      return;
    }
    if (store.palette.open) {
      closePalette();
      return;
    }
    if (document.getElementById('drawer-root')?.classList.contains('open')) closeDrawer();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    togglePalette();
    return;
  }
  if (store.palette.open) {
    const total = store.palette.filtered.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!total) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      store.palette.active = (store.palette.active + delta + total) % total;
      renderPaletteActive();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      executePalette(store.palette.active);
    }
    return;
  }
  if (isTyping(event.target)) return;
  if ((event.altKey || !event.metaKey) && !event.ctrlKey && /^[1-7]$/.test(event.key)) {
    event.preventDefault();
    navigate(NAV[Number(event.key) - 1].id);
    return;
  }
  if (event.altKey && /^[1-7]$/.test(event.key)) {
    event.preventDefault();
    navigate(NAV[Number(event.key) - 1].id);
  }
}

const paletteActions = {
  prepare: () => runPrepare(),
  live: () => runLiveStart(),
  pause: () => runLivePause(),
  resume: () => runLiveResume(),
  stop: () => runLiveStop(),
  review: () => runReview(),
  scenario: () => runScenario('negative'),
  stress: () => runStress(800),
  acceptance: () => loadAcceptance({ force: true }),
  reset: () => runReset(),
  copilot: () => toggleCopilot()
};

function buildPaletteItems() {
  const items = [];
  const primary = primaryAction(store.state);
  items.push({
    group: '常用动作',
    label: primary.label,
    hint: primary.note,
    icon: primary.icon,
    run: () => actions[primary.act]()
  });
  items.push({ group: '常用动作', label: '一键演示', hint: '按剧本跑完筹备到复盘', icon: 'play', run: () => runDemo() });
  items.push({ group: '常用动作', label: '功能地图', hint: '全部能力与所在视图', icon: 'map', run: () => openFunctionMap() });
  NAV.forEach((item) => {
    items.push({
      group: '跳转',
      label: item.label,
      hint: item.desc,
      icon: item.icon,
      run: () => navigate(item.id)
    });
  });
  items.push({ group: '动作', label: '生成直播方案', hint: 'Plan-Execute · CNP', icon: 'sparkles', run: paletteActions.prepare });
  const stage = store.state?.session?.stage;
  if (stage === 'live') {
    items.push({ group: '动作', label: '暂停直播', hint: 'LIVE OPS', icon: 'pause', run: paletteActions.pause });
    items.push({ group: '动作', label: '结束直播', hint: 'LIVE OPS', icon: 'stop', run: paletteActions.stop });
  } else if (stage === 'paused') {
    items.push({ group: '动作', label: '继续直播', hint: 'LIVE OPS', icon: 'play', run: paletteActions.resume });
    items.push({ group: '动作', label: '结束直播', hint: 'LIVE OPS', icon: 'stop', run: paletteActions.stop });
  } else if (stage === 'ended' || stage === 'reviewed') {
    items.push({ group: '动作', label: '生成复盘', hint: 'Reflexion + Causal', icon: 'review', run: paletteActions.review });
  } else {
    items.push({ group: '动作', label: '开始直播', hint: 'LIVE OPS', icon: 'play', run: paletteActions.live });
  }
  items.push({ group: '动作', label: '注入负面舆情', hint: 'ReAct · Consensus', icon: 'alert', run: paletteActions.scenario });
  items.push({ group: '动作', label: '运行 800 条压测', hint: 'P99 / Throughput', icon: 'gauge', run: paletteActions.stress });
  items.push({ group: '动作', label: '运行系统验收', hint: '20 probes', icon: 'shield', run: paletteActions.acceptance });
  items.push({ group: '动作', label: '折叠 / 展开 Copilot', hint: 'Panel', icon: 'message', run: paletteActions.copilot });
  items.push({ group: '动作', label: '重置当前演示', hint: 'Reset', icon: 'refresh', run: paletteActions.reset });
  (store.state?.agents ?? []).forEach((agent) => {
    items.push({
      group: '智能体',
      label: `${agent.name} · ${agent.title}`,
      hint: agent.id,
      icon: 'agents',
      run: () => openAgentDetail(agent.id)
    });
  });
  (store.state?.tools ?? []).forEach((tool) => {
    items.push({
      group: '工具',
      label: tool.name,
      hint: `${tool.category} · ${tool.riskLevel}`,
      icon: 'tool',
      run: () => openToolDetail(tool.name)
    });
  });
  return items;
}

function openPalette() {
  if (!store.state) return;
  const rootEl = document.getElementById('palette-root');
  if (!rootEl) return;
  rootEl.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
    <div class="palette-search">
      ${icon('search', 16)}
      <input id="palette-input" placeholder="跳转视图、执行动作或搜索工具…" autocomplete="off" />
      <kbd>ESC</kbd>
    </div>
    <div class="palette-list" id="palette-list"></div>
    <div class="palette-foot"><span>↑↓ 选择 · ↵ 执行</span><span>${NAV.length} VIEWS · ${
      store.state.tools?.length ?? 0
    } TOOLS</span></div>
  </div>`;
  rootEl.classList.add('open');
  rootEl.setAttribute('aria-hidden', 'false');
  store.palette = { open: true, items: buildPaletteItems(), filtered: [], active: 0 };
  const input = document.getElementById('palette-input');
  input.addEventListener('input', () => {
    store.palette.active = 0;
    renderPalette(input.value);
  });
  input.focus();
  renderPalette('');
}

function closePalette() {
  const rootEl = document.getElementById('palette-root');
  if (!rootEl) return;
  rootEl.classList.remove('open');
  rootEl.setAttribute('aria-hidden', 'true');
  store.palette.open = false;
  setTimeout(() => {
    if (!rootEl.classList.contains('open')) rootEl.innerHTML = '';
  }, 220);
}

function togglePalette() {
  if (store.palette.open) closePalette();
  else openPalette();
}

function renderPalette(query) {
  const list = document.getElementById('palette-list');
  if (!list) return;
  const normalized = query.trim().toLowerCase();
  let items = store.palette.items;
  if (normalized) {
    items = items.filter((item) =>
      `${item.label} ${item.hint} ${item.group}`.toLowerCase().includes(normalized)
    );
  } else {
    items = items.filter((item) => item.group !== '工具');
  }
  store.palette.filtered = items.slice(0, 40);
  if (!store.palette.filtered.length) {
    list.innerHTML = '<div class="empty"><strong>没有匹配项</strong><p>试试视图名、智能体或工具名。</p></div>';
    return;
  }
  const groups = [];
  store.palette.filtered.forEach((item, index) => {
    let group = groups.find((entry) => entry.name === item.group);
    if (!group) {
      group = { name: item.group, items: [] };
      groups.push(group);
    }
    group.items.push(
      `<button class="palette-item ${index === store.palette.active ? 'active' : ''}" data-palette-index="${index}">
        ${icon(item.icon, 15)}
        <span>${esc(item.label)}</span>
        <small>${esc(item.hint)}</small>
      </button>`
    );
  });
  list.innerHTML = groups
    .map((group) => `<div class="palette-group">${esc(group.name)}</div>${group.items.join('')}`)
    .join('');
}

function renderPaletteActive() {
  document.querySelectorAll('.palette-item').forEach((el) => {
    const active = Number(el.dataset.paletteIndex) === store.palette.active;
    el.classList.toggle('active', active);
    if (active) el.scrollIntoView({ block: 'nearest' });
  });
}

function executePalette(index) {
  const item = store.palette.filtered[index];
  if (!item) return;
  closePalette();
  item.run();
}

function startParticles() {
  const canvas = document.getElementById('particles');
  if (!canvas || reducedMotion.matches) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const palette = ['rgba(11,110,85,', 'rgba(169,121,47,', 'rgba(63,112,180,'];
  let width = 0;
  let height = 0;
  let particles = [];
  let frame = 0;
  let running = true;

  const spawn = () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.16,
    vy: (Math.random() - 0.5) * 0.14,
    r: Math.random() * 1.3 + 0.4,
    alpha: Math.random() * 0.4 + 0.1,
    color: palette[Math.floor(Math.random() * palette.length)]
  });

  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(68, Math.max(26, width / 26)));
    particles = Array.from({ length: count }, spawn);
  };

  const draw = () => {
    if (!running) return;
    ctx.clearRect(0, 0, width, height);
    for (const particle of particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;
      if (particle.x < -10) particle.x = width + 10;
      if (particle.x > width + 10) particle.x = -10;
      if (particle.y < -10) particle.y = height + 10;
      if (particle.y > height + 10) particle.y = -10;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
      ctx.fillStyle = `${particle.color}${particle.alpha})`;
      ctx.fill();
    }
    if (width > 900) {
      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 118) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(11,110,85,${((1 - distance / 118) * 0.09).toFixed(3)})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
    }
    frame = requestAnimationFrame(draw);
  };

  resize();
  draw();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      draw();
    }
  });
}

function startAmbientParallax() {
  const ambient = document.querySelector('.ambient');
  if (!ambient || reducedMotion.matches) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  let raf = 0;
  let targetX = 0;
  let targetY = 0;
  const apply = () => {
    raf = 0;
    ambient.style.setProperty('--par-x', `${targetX.toFixed(2)}px`);
    ambient.style.setProperty('--par-y', `${targetY.toFixed(2)}px`);
  };
  window.addEventListener(
    'pointermove',
    (event) => {
      targetX = (0.5 - event.clientX / window.innerWidth) * 22;
      targetY = (0.5 - event.clientY / window.innerHeight) * 16;
      if (!raf) raf = requestAnimationFrame(apply);
    },
    { passive: true }
  );
}

function startClock() {
  const tick = () => setText('sb-clock', fmtClock(Date.now()));
  tick();
  setInterval(tick, 1000);
}

function renderBootError(error) {
  root.innerHTML = `<div class="boot-screen">
    <div class="boot-mark"><span></span><span></span><span></span><span></span></div>
    <div class="boot-word">NEXUS OFFLINE</div>
    <div class="boot-line" style="max-width:520px;text-align:center;line-height:1.8">${esc(errorMessage(error))}</div>
    <button class="btn primary" id="boot-retry" style="margin-top:10px">${icon('refresh', 14)}重新连接</button>
  </div>`;
  document.getElementById('boot-retry')?.addEventListener('click', () => window.location.reload());
}

async function boot() {
  const bootLine = document.querySelector('.boot-line');
  try {
    if (bootLine) bootLine.textContent = '同步运行状态与黑板版本…';
    const [response] = await Promise.all([api.state(), sleep(360)]);
    store.state = response.state;
    mountShell();
    bindEvents();
    startParticles();
    startAmbientParallax();
    connectStream();
    startClock();
    updateShell();
    paint({ urgent: true, animate: true });
    if (store.view === 'system') void loadAcceptance({ silent: true, focusView: false });
    setTimeout(startCoach, 1200);
  } catch (error) {
    renderBootError(error);
  }
}

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onHashChange);
  window.addEventListener('beforeunload', () => store.source?.close());
  document.getElementById('chat-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendChat(document.getElementById('chat-input')?.value);
    }
  });
  document.getElementById('chat-input')?.addEventListener('input', () => {
    autoGrow(document.getElementById('chat-input'));
    syncComposerState();
  });
  document.getElementById('palette-root')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closePalette();
  });
  document.getElementById('coach-root')?.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-coach]');
    if (!trigger) return;
    event.preventDefault();
    if (trigger.dataset.coach === 'next') coachNext();
    else endCoach(true);
  });
  window.addEventListener('resize', () => {
    const wide = window.matchMedia('(min-width: 1441px)').matches;
    if (wide) setCopilot(storage.get('nexus.copilot') !== 'closed', false);
    else setCopilot(false, false);
    if (coachState) renderCoach();
  });
}

window.__NEXUS__ = {
  get state() {
    return store.state;
  },
  get view() {
    return store.view;
  },
  navigate,
  chat: sendChat,
  refresh: manualRefresh,
  store
};

void boot();
