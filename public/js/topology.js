import { esc, safeColor } from './ui.js';

const ROLE_ORDER = ['selector', 'controller', 'speaker', 'analyst'];

const ROLE_COPY = {
  selector: 'PLAN',
  controller: 'OPS',
  speaker: 'VOICE',
  analyst: 'INSIGHT'
};

function statusColor(status) {
  if (status === 'active') return '#0b7a5e';
  if (status === 'standby') return '#87988e';
  return '#b84252';
}

function statusLabel(status) {
  if (status === 'active') return 'ACTIVE';
  if (status === 'standby') return 'STANDBY';
  return 'OFFLINE';
}

function packet(pathId, color, duration = 4) {
  return `<circle r="2.2" fill="${color}" opacity=".85">
    <animateMotion dur="${duration}s" repeatCount="indefinite" rotate="auto">
      <mpath href="#${pathId}"/>
    </animateMotion>
  </circle>`;
}

function renderNode(agent, { x, y, r = 25, compact = false, clickable = true }) {
  const accent = safeColor(agent.accent);
  const color = statusColor(agent.status);
  const load = Math.min(1, Math.max(0, Number(agent.load) || 0));
  const circumference = 2 * Math.PI * (r + 5);
  const dash = (load * circumference).toFixed(1);
  const title = `${agent.name} · ${agent.title} · ${statusLabel(agent.status)}`;
  return `<g class="${clickable ? 'topo-node' : ''}" ${clickable ? `data-act="agent" data-agent="${esc(agent.id)}"` : ''} style="cursor:${
    clickable ? 'pointer' : 'default'
  }">
    <title>${esc(title)}</title>
    <circle cx="${x}" cy="${y}" r="${r + 5}" fill="none" stroke="rgba(22,42,34,.1)" stroke-width="2"/>
    <circle cx="${x}" cy="${y}" r="${r + 5}" fill="none" stroke="${accent}" stroke-width="1.4" stroke-linecap="round"
      stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 ${x} ${y})" opacity=".58"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="${accent}" fill-opacity=".08" stroke="${accent}" stroke-opacity=".32"/>
    <text x="${x}" y="${y + 1}" text-anchor="middle" dominant-baseline="middle" fill="${accent}" font-size="${
      compact ? 11 : 13
    }" font-family="serif">${esc(agent.name)}</text>
    <circle cx="${x + r - 2}" cy="${y - r + 2}" r="3.2" fill="${color}" stroke="#fbf9f4" stroke-width="1.2">
      ${agent.status === 'active' ? `<animate attributeName="opacity" values="1;.45;1" dur="2.4s" repeatCount="indefinite"/>` : ''}
    </circle>
    <text x="${x}" y="${y + r + 15}" text-anchor="middle" fill="#3d5047" font-size="9" font-family="sans-serif">${esc(
      agent.title
    )}</text>
    <text x="${x}" y="${y + r + 26}" text-anchor="middle" fill="${color}" font-size="6.5" font-family="monospace" letter-spacing=".08em">${statusLabel(
      agent.status
    )}</text>
    ${
      compact
        ? ''
        : `<text x="${x}" y="${y + r + 37}" text-anchor="middle" fill="rgba(86,107,96,.78)" font-size="6.2" font-family="monospace">${esc(
            agent.cognition
          )}</text>`
    }
  </g>`;
}

function layout(agents, compact) {
  const roles = ROLE_ORDER.map((role) => {
    const group = agents.filter((agent) => agent.logicalRole === role);
    return {
      role,
      primary: group.find((agent) => !agent.replicaOf) ?? group[0] ?? null,
      replica: group.find((agent) => agent.replicaOf) ?? null,
      all: group
    };
  }).filter((item) => item.primary);
  return roles;
}

export function topology(agents = [], { compact = true } = {}) {
  const roles = layout(agents, compact);
  const width = compact ? 620 : 900;
  const height = compact ? 300 : 440;
  const cx = width / 2;
  const cy = height / 2;
  const spreadX = compact ? 200 : 300;
  const spreadY = compact ? 104 : 150;
  const offsets = [
    { x: -spreadX, y: -spreadY },
    { x: spreadX, y: -spreadY },
    { x: -spreadX, y: spreadY },
    { x: spreadX, y: spreadY }
  ];
  const positions = new Map();
  roles.forEach((item, index) => {
    const base = offsets[index] ?? offsets[0];
    positions.set(item.role, { x: cx + base.x, y: cy + base.y, ...item });
  });

  const paths = [];
  const packets = [];
  const nodes = [];
  roles.forEach((item, index) => {
    const pos = positions.get(item.role);
    const pathId = `topo-path-${compact ? 'c' : 'f'}-${index}`;
    const path = `M${cx},${cy} C${(cx + pos.x) / 2},${cy} ${(cx + pos.x) / 2},${pos.y} ${pos.x},${pos.y}`;
    paths.push(
      `<path id="${pathId}" d="${path}" fill="none" stroke="rgba(11,122,94,.2)" stroke-width="1" ${
        item.primary.status === 'offline' ? 'stroke-dasharray="3 4"' : ''
      }/>`
    );
    const accent = safeColor(item.primary.accent);
    packets.push(packet(pathId, accent, 3.8 + index * 0.7));
    nodes.push(renderNode(item.primary, { x: pos.x, y: pos.y, r: compact ? 24 : 28, compact }));
    if (item.replica) {
      const rx = pos.x + (pos.x < cx ? -1 : 1) * (compact ? 68 : 92);
      const ry = pos.y + (compact ? 56 : 66);
      paths.push(
        `<path d="M${pos.x},${pos.y + 22} L${rx},${ry - 16}" stroke="rgba(22,42,34,.16)" stroke-width="1" stroke-dasharray="2 4"/>`
      );
      nodes.push(
        renderNode(item.replica, {
          x: rx,
          y: ry,
          r: compact ? 15 : 18,
          compact: true
        })
      );
    }
  });

  const busColor = '#0a5c47';
  const center = `<g>
    <circle cx="${cx}" cy="${cy}" r="${compact ? 36 : 44}" fill="rgba(11,122,94,.06)" stroke="rgba(11,122,94,.28)"/>
    <circle cx="${cx}" cy="${cy}" r="${compact ? 46 : 56}" fill="none" stroke="rgba(11,122,94,.12)" stroke-dasharray="2 5"/>
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${busColor}" font-size="${compact ? 9 : 11}" font-family="monospace" letter-spacing=".1em">A2A BUS</text>
    <text x="${cx}" y="${cy + 10}" text-anchor="middle" fill="rgba(86,107,96,.82)" font-size="6.5" font-family="monospace">ORCHESTRATOR</text>
    <text x="${cx}" y="${cy + (compact ? 26 : 30)}" text-anchor="middle" fill="rgba(11,122,94,.6)" font-size="6" font-family="monospace">VERSIONED BLACKBOARD</text>
  </g>`;

  return `<svg class="chart-svg ${compact ? 'topology-compact' : 'topology-full'}" viewBox="0 0 ${width} ${height}" role="img" aria-label="多智能体协同拓扑">
    <defs>
      <radialGradient id="topo-glow-${compact ? 'c' : 'f'}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#2a8a6c" stop-opacity=".12"/>
        <stop offset="100%" stop-color="#2a8a6c" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#topo-glow-${compact ? 'c' : 'f'})" opacity=".7"/>
    ${paths.join('')}
    ${packets.join('')}
    ${center}
    ${nodes.join('')}
  </svg>`;
}
