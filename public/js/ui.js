const ICONS = {
  overview:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  agents:
    '<circle cx="12" cy="5.5" r="2.6"/><circle cx="5.5" cy="17.5" r="2.6"/><circle cx="18.5" cy="17.5" r="2.6"/><path d="M10.6 7.7 6.9 15M13.4 7.7l3.7 7.3M8.1 17.5h7.8"/>',
  live:
    '<circle cx="12" cy="12" r="2.4"/><path d="M7.4 7.4a6.5 6.5 0 0 0 0 9.2M16.6 16.6a6.5 6.5 0 0 0 0-9.2M4.4 4.4a10.8 10.8 0 0 0 0 15.2M19.6 19.6a10.8 10.8 0 0 0 0-15.2"/>',
  decisions:
    '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M8.2 6h7.6M7.1 8l3.7 8M16.9 8l-3.7 8"/>',
  review:
    '<path d="M9 3h6M10 3v5.2L5.6 17a2.2 2.2 0 0 0 1.9 3.3h9a2.2 2.2 0 0 0 1.9-3.3L14 8.2V3"/><path d="M7.2 13h9.6M9.2 16.2h.01"/>',
  protocol:
    '<path d="M8 8a4 4 0 0 1 4-4h1M16 16a4 4 0 0 1-4 4h-1"/><rect x="2.5" y="8" width="5.5" height="8" rx="2"/><rect x="16" y="8" width="5.5" height="8" rx="2"/><path d="M8 12h8"/>',
  system:
    '<path d="M12 3 4.5 6v5.4c0 4.6 3.1 8.2 7.5 9.6 4.4-1.4 7.5-5 7.5-9.6V6L12 3Z"/><path d="m8.7 12 2.1 2.1 4.5-4.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  command:
    '<path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5H15a2.5 2.5 0 1 0-2.5-2.5v11a2.5 2.5 0 1 0 2.5-2.5H6.5A2.5 2.5 0 1 0 9 17.5v-11Z"/>',
  play: '<path d="M8 5.2v13.6L19 12 8 5.2Z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8.2A7.5 7.5 0 0 1 19.4 12M4.6 12a7.5 7.5 0 0 0 13.3 3.8"/>',
  sparkles:
    '<path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>',
  arrowRight: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  arrowUpRight: '<path d="M7 17 17 7M8 7h9v9"/>',
  cpu:
    '<rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  layers:
    '<path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/>',
  message:
    '<path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 9 9 0 0 1-3.2-.6L4 20l1.4-4.2A7.4 7.4 0 0 1 4 11.5a7.5 7.5 0 0 1 8-7.5 7.5 7.5 0 0 1 8 7.5Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>',
  activity: '<path d="M3 12h4l2.2-6.5L14 19l2.3-7H21"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  alert:
    '<path d="M12 3.5 22 20H2L12 3.5Z"/><path d="M12 9v5M12 17.2h.01"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tool:
    '<path d="M14.7 6.3a4.5 4.5 0 0 0-5.9 5.9L4 17l3 3 4.8-4.8a4.5 4.5 0 0 0 5.9-5.9l-2.6 2.6-2.2-2.2 2.6-2.6Z"/>',
  send: '<path d="m4 11 16-7-6.5 16-2.3-6.7L4 11Z"/><path d="m11.2 13.3 4.4-4.4"/>',
  brain:
    '<path d="M9.5 4a3 3 0 0 0-3 3 3 3 0 0 0-1.8 5.4A3.2 3.2 0 0 0 7 18.5 3 3 0 0 0 12 20V5.8A2 2 0 0 0 10.2 4h-.7Z"/><path d="M14.5 4a3 3 0 0 1 3 3 3 3 0 0 1 1.8 5.4A3.2 3.2 0 0 1 17 18.5 3 3 0 0 1 12 20M15 9h1.5M7.5 9H9M8 14h1.5M15.5 14H17"/>',
  gauge:
    '<path d="M4 17a8.5 8.5 0 1 1 16 0"/><path d="m12 13 4-4"/><circle cx="12" cy="17" r="1.6"/>',
  trash:
    '<path d="M4 7h16M9 7V4h6v3M6.5 7l.8 13h9.4l.8-13M10 11v5M14 11v5"/>',
  copy:
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  filter: '<path d="M4 5h16l-6.2 7v6l-3.6 2v-8L4 5Z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  zap: '<path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z"/>',
  shield:
    '<path d="M12 3 4.5 6v5.4c0 4.6 3.1 8.2 7.5 9.6 4.4-1.4 7.5-5 7.5-9.6V6L12 3Z"/>',
  users:
    '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M18 20a5.6 5.6 0 0 0-2.5-4.6"/>',
  broadcast:
    '<circle cx="12" cy="12" r="2"/><path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8M5 5a9.9 9.9 0 0 0 0 14M19 5a9.9 9.9 0 0 1 0 14"/>',
  terminal:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  book:
    '<path d="M4 4.5h6.5A2.5 2.5 0 0 1 13 7v13a2.5 2.5 0 0 0-2.5-2.5H4v-13ZM20 4.5h-4.5A2.5 2.5 0 0 0 13 7v13a2.5 2.5 0 0 1 2.5-2.5H20v-13Z"/>',
  lock:
    '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  external: '<path d="M14 4h6v6M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  waveform: '<path d="M3 12h2l2-6 3 12 3-15 2.5 13 2-4H21"/>',
  target:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  flow:
    '<rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="15" y="15" width="6" height="5" rx="1.5"/><path d="M9 6.5h3.5A2.5 2.5 0 0 1 15 9v6"/><path d="m13 13 2 2 2-2"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 2.5v5M16 2.5v5"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  map: '<path d="M9 4.5 3.5 6.8v13L9 17.5l6 2.5 5.5-2.3v-13L15 7 9 4.5Z"/><path d="M9 4.5v13M15 7v13"/>',
  help:
    '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.2-2.6 4"/><path d="M12 17.4h.01"/>',
  flag: '<path d="M5 21V4h9l-1.2 3.6H20l-2.4 5.4L20 18h-9l-1-3H5"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'
};

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export const NAV = [
  { id: 'overview', label: '本场总览', latin: 'COMMAND', icon: 'overview', shortcut: '1', desc: '看 KPI，走完五个阶段' },
  { id: 'agents', label: '智能体', latin: 'AGENTS', icon: 'agents', shortcut: '2', desc: '四个 Actor 与热备接管' },
  { id: 'live', label: '直播中控', latin: 'LIVE OPS', icon: 'live', shortcut: '3', desc: '发弹幕、看实时决策' },
  { id: 'decisions', label: '决策追溯', latin: 'TRACE', icon: 'decisions', shortcut: '4', desc: '按风险筛选，回溯 trace' },
  { id: 'review', label: '复盘', latin: 'REVIEW', icon: 'review', shortcut: '5', desc: '因果归因与下一场动作' },
  { id: 'protocol', label: '工具与协议', latin: 'PROTOCOL', icon: 'protocol', shortcut: '6', desc: '挂载 MCP 工具与 A2A' },
  { id: 'system', label: '系统验收', latin: 'SYSTEM', icon: 'system', shortcut: '7', desc: '20 项探针、压测与容灾' }
];

export const VIEW_META = {
  overview: {
    title: '本场总览',
    sub: '本场进度、关键指标与下一步动作',
    latin: 'COMMAND DECK'
  },
  agents: {
    title: '智能体',
    sub: '四个对等 Actor，谁下线都有热备接管',
    latin: 'AGENT MATRIX'
  },
  live: {
    title: '直播中控',
    sub: '这里可以发弹幕、注入舆情演练，并看到实时决策',
    latin: 'LIVE OPERATIONS'
  },
  decisions: {
    title: '决策追溯',
    sub: '按智能体与风险筛选，点开任意一条看完整证据链',
    latin: 'DECISION INTELLIGENCE'
  },
  review: {
    title: '复盘',
    sub: '下播后在这里看因果结论与下一场动作',
    latin: 'REVIEW LAB'
  },
  protocol: {
    title: '工具与协议',
    sub: '挂载新的 MCP 工具，查看 A2A 信封与黑板版本',
    latin: 'PROTOCOL WORKSHOP'
  },
  system: {
    title: '系统验收',
    sub: '跑 20 项探针与压测，现场验证稳定性',
    latin: 'SYSTEM & ACCEPTANCE'
  }
};

export const STAGE = {
  prep: { label: '筹备中', tone: 'mint' },
  ready: { label: '方案就绪', tone: 'mint' },
  live: { label: '直播中', tone: 'danger' },
  paused: { label: '已暂停', tone: 'amber' },
  ended: { label: '已下播', tone: 'blue' },
  reviewed: { label: '已复盘', tone: 'blue' },
  idle: { label: '待命', tone: 'mint' }
};

export const AGENT_ROLE = {
  selector: { cn: '策选', role: '选品策划', accent: '#0d7f63', glyph: '策' },
  controller: { cn: '场控', role: '场控互动', accent: '#a9772c', glyph: '场' },
  speaker: { cn: '言枢', role: '话术生成', accent: '#3f72bd', glyph: '言' },
  analyst: { cn: '观澜', role: '数据复盘', accent: '#c05572', glyph: '观' },
  compliance: { cn: '合规哨兵', role: '规则与红线', accent: '#b84252', glyph: '规' },
  orchestrator: { cn: '中枢', role: '运行编排', accent: '#6d8177', glyph: '枢' }
};

export function icon(name, size = 16, cls = '') {
  const body = ICONS[name] ?? ICONS.dot;
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function logoMark(size = 38) {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M32 5 55 18v28L32 59 9 46V18L32 5Z" stroke="rgba(11,110,85,.4)" stroke-width="1"/>
    <path d="M32 13 48 22.5v19L32 51 16 41.5v-19L32 13Z" stroke="rgba(11,110,85,.2)" stroke-width=".8"/>
    <circle cx="32" cy="21" r="3.3" fill="#0d7f63"/>
    <circle cx="44" cy="39" r="3.3" fill="#0d7f63" opacity=".9"/>
    <circle cx="20" cy="39" r="3.3" fill="#0d7f63" opacity=".9"/>
    <path d="M32 24.3v6.2M32 30.5 20 39M32 30.5 44 39" stroke="rgba(10,93,72,.55)" stroke-width="1.1"/>
    <circle cx="32" cy="30.5" r="2.2" fill="#0b6e55"/>
  </svg>`;
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function safeColor(value, fallback = '#0b7a5e') {
  return SAFE_COLOR.test(String(value ?? '')) ? value : fallback;
}

export function fmtMoney(value) {
  const number = Number(value) || 0;
  return `¥${Math.round(number).toLocaleString('zh-CN')}`;
}

export function fmtNum(value) {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

export function fmtPct(value, digits = 1) {
  return `${((Number(value) || 0) * 100).toFixed(digits)}%`;
}

export function fmtMs(value) {
  const number = Number(value) || 0;
  return `${number < 10 ? number.toFixed(2) : number.toFixed(0)}ms`;
}

export function fmtClock(ts = Date.now()) {
  const date = new Date(ts);
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtTime(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function relTime(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - new Date(ts).getTime());
  if (diff < 12000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

export function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function shortId(id, head = 10) {
  const text = String(id ?? '—');
  return text.length > head ? `${text.slice(0, head)}…` : text;
}

export function stageMeta(stage) {
  return STAGE[stage] ?? STAGE.idle;
}

export function riskMeta(risk) {
  return {
    critical: { label: 'RED LINE', tone: 'danger', text: '红线' },
    high: { label: 'HIGH', tone: 'amber', text: '高风险' },
    medium: { label: 'MEDIUM', tone: 'blue', text: '中风险' },
    low: { label: 'LOW', tone: 'mint', text: '低风险' }
  }[risk] ?? { label: 'LOW', tone: 'mint', text: '低风险' };
}

export function statusText(status) {
  return {
    executed: '已执行',
    guarded: '已护栏',
    blocked: '已阻断',
    vetoed: '已否决',
    ignored: '已降级',
    running: '进行中',
    open: '待处理',
    ok: '正常',
    pass: '通过',
    warn: '待验证',
    fail: '失败'
  }[status] ?? status ?? '—';
}

export function agentInfo(state, id) {
  if (!id) return AGENT_ROLE.orchestrator;
  const agent = (state?.agents ?? []).find((item) => item.id === id || item.logicalRole === id);
  if (agent) {
    return {
      cn: agent.name,
      role: agent.title,
      accent: safeColor(agent.accent),
      glyph: AGENT_ROLE[agent.logicalRole]?.glyph ?? String(agent.name ?? '枢').slice(0, 1),
      agent
    };
  }
  return AGENT_ROLE[id] ?? AGENT_ROLE.orchestrator;
}

export function agentOrb(state, id, size = 30) {
  const info = agentInfo(state, id);
  const accent = safeColor(info.accent);
  return `<span class="agent-orb" style="--orb:${accent};width:${size}px;height:${size}px;font-size:${Math.max(
    9,
    Math.round(size * 0.38)
  )}px" title="${esc(info.cn)} · ${esc(info.role)}">${esc(info.glyph)}</span>`;
}

export function badge(text, tone = '', extra = '') {
  return `<span class="badge ${tone} ${extra}">${esc(text)}</span>`;
}

export function tag(text) {
  return `<span class="tag">${esc(text)}</span>`;
}

export function empty(title, desc = '', iconName = 'dot') {
  return `<div class="empty">${icon(iconName, 24)}<strong>${esc(title)}</strong>${
    desc ? `<p>${esc(desc)}</p>` : ''
  }</div>`;
}

export function pageHead({ eyebrow = '', title = '', desc = '', actions = '' }) {
  return `<div class="page-head">
    <div>
      ${eyebrow ? `<div class="page-eyebrow">${esc(eyebrow)}</div>` : ''}
      <h2 class="page-title">${esc(title)}</h2>
      ${desc ? `<p class="page-desc">${desc}</p>` : ''}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </div>`;
}

export function panel({ title = '', desc = '', tools = '', body = '', foot = '', cls = '', flush = false }) {
  return `<section class="panel ${cls}">
    ${
      title
        ? `<div class="panel-head"><div class="panel-title"><h3>${esc(title)}</h3>${
            desc ? `<p>${desc}</p>` : ''
          }</div>${tools ? `<div class="panel-tools">${tools}</div>` : ''}</div>`
        : ''
    }
    <div class="panel-body ${flush ? 'flush' : ''}">${body}</div>
    ${foot ? `<div class="panel-foot">${foot}</div>` : ''}
  </section>`;
}

export function formatText(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br />');
}

export function toast(title, message = '', tone = 'ok', timeout = 4200) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.innerHTML = `<span class="toast-icon">${icon(tone === 'danger' ? 'alert' : tone === 'warn' ? 'clock' : 'check', 16)}</span>
    <div><b>${esc(title)}</b>${message ? `<p>${esc(message)}</p>` : ''}</div>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, timeout);
}

export function openDrawer({ eyebrow = '', title = '', desc = '', body = '' }) {
  const root = document.getElementById('drawer-root');
  if (!root) return;
  root.innerHTML = `
    <div class="drawer-backdrop" data-close-drawer></div>
    <aside class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <div class="drawer-head-copy">
          <div class="kicker">${esc(eyebrow)}</div>
          <h2>${esc(title)}</h2>
          ${desc ? `<p>${esc(desc)}</p>` : ''}
        </div>
        <button class="drawer-close" data-close-drawer aria-label="关闭">${icon('x', 15)}</button>
      </div>
      <div class="drawer-body">${body}</div>
    </aside>`;
  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  root.querySelectorAll('[data-close-drawer]').forEach((el) => {
    el.addEventListener('click', closeDrawer);
  });
}

export function updateDrawer(html) {
  const body = document.querySelector('#drawer-root .drawer-body');
  if (body) body.innerHTML = html;
}

export function closeDrawer() {
  const root = document.getElementById('drawer-root');
  if (!root) return;
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (!root.classList.contains('open')) root.innerHTML = '';
  }, 420);
}

export function confirmDialog({
  title = '确认执行',
  desc = '该动作会改变当前演示状态。',
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger'
} = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('confirm-root');
    root.innerHTML = `<div class="confirm-card">
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      <div class="confirm-actions">
        <button class="btn ghost" data-confirm-cancel>${esc(cancelLabel)}</button>
        <button class="btn ${tone}" data-confirm-ok>${esc(confirmLabel)}</button>
      </div>
    </div>`;
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    const finish = (value) => {
      root.classList.remove('open');
      root.setAttribute('aria-hidden', 'true');
      setTimeout(() => {
        root.innerHTML = '';
      }, 220);
      resolve(value);
    };
    root.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false));
    root.querySelector('[data-confirm-ok]').addEventListener('click', () => finish(true));
    root.addEventListener(
      'click',
      (event) => {
        if (event.target === root) finish(false);
      },
      { once: true }
    );
  });
}

export async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(String(text));
    toast(label, String(text).slice(0, 80));
  } catch {
    toast('复制失败', '浏览器未授权剪贴板访问。', 'warn');
  }
}

export function tabBar(items, active, action = 'tab') {
  return `<div class="tabs">${items
    .map(
      (item) =>
        `<button class="tab ${item.id === active ? 'active' : ''}" data-act="${action}" data-tab="${
          item.id
        }">${esc(item.label)}</button>`
    )
    .join('')}</div>`;
}

export function disclosure(title, content, open = false) {
  return `<details class="detail-section" ${open ? 'open' : ''}>
    <summary style="cursor:pointer;list-style:none;font-family:var(--font-mono);font-size:8px;letter-spacing:.14em;color:var(--faint);padding:4px 0">${esc(
      title
    )}</summary>
    <div style="margin-top:8px">${content}</div>
  </details>`;
}
