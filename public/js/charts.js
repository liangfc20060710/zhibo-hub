import { esc } from './ui.js';

let uidCounter = 0;
const nextId = (prefix) => `${prefix}-${(uidCounter += 1)}`;

function numeric(values) {
  return (values ?? []).map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0));
}

function extent(series) {
  const all = series.flatMap((item) => numeric(item.values));
  if (!all.length) return [0, 1];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min = Math.max(0, min - 1);
    max += 1;
  }
  return [min, max];
}

function smoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(
      2
    )},${p2[1].toFixed(2)}`;
  }
  return path;
}

export function sparkline(values, { width = 180, height = 28, color = '#0b7a5e', fill = true } = {}) {
  const data = numeric(values);
  if (data.length < 2) {
    return `<svg class="kpi-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="M0 ${height - 2} H${width}" stroke="rgba(22,42,34,.12)" stroke-width="1"/></svg>`;
  }
  const [min, max] = extent([{ values: data }]);
  const step = width / Math.max(data.length - 1, 1);
  const points = data.map((value, index) => [
    index * step,
    height - 2 - ((value - min) / (max - min)) * (height - 5)
  ]);
  const line = smoothPath(points);
  const id = nextId('spark');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return `<svg class="kpi-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".24"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${fill ? `<path d="${area}" fill="url(#${id})"/>` : ''}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" opacity=".92"/>
  </svg>`;
}

export function areaChart({
  series = [],
  labels = [],
  height = 224,
  yFormat = (value) => value,
  emptyText = '等待实时数据'
} = {}) {
  const drawable = series.filter((item) => (item.values ?? []).length);
  if (!drawable.length) {
    return `<div class="chart-empty"><span class="kicker">暂无数据</span><span>${esc(emptyText)}</span></div>`;
  }
  const width = 860;
  const pad = { top: 18, right: 14, bottom: 26, left: 50 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const length = Math.max(...drawable.map((item) => item.values.length), 2);
  const [min, max] = extent(drawable);
  const span = max - min || 1;
  const x = (index) => pad.left + (index / Math.max(length - 1, 1)) * innerW;
  const y = (value) => pad.top + innerH - ((value - min) / span) * innerH;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const value = min + span * ratio;
      const gy = pad.top + innerH - ratio * innerH;
      return `<line x1="${pad.left}" y1="${gy}" x2="${width - pad.right}" y2="${gy}" stroke="rgba(22,42,34,.07)" stroke-width="1"/>
        <text x="${pad.left - 9}" y="${gy + 3}" fill="rgba(86,107,96,.9)" font-size="7" text-anchor="end" font-family="monospace">${esc(
          yFormat(value)
        )}</text>`;
    })
    .join('');

  const labelCount = Math.min(6, labels.length || length);
  const xLabels =
    labels.length && labelCount > 0
      ? Array.from({ length: labelCount }, (_, index) => {
          const sourceIndex = Math.round((index / Math.max(labelCount - 1, 1)) * (labels.length - 1));
          const lx = x((sourceIndex / Math.max(labels.length - 1, 1)) * (length - 1));
          return `<text x="${lx.toFixed(1)}" y="${height - 7}" fill="rgba(86,107,96,.82)" font-size="7" text-anchor="middle" font-family="monospace">${esc(
            labels[sourceIndex]
          )}</text>`;
        }).join('')
      : '';

  const paths = drawable
    .map((item, index) => {
      const color = item.color ?? ['#0b7a5e', '#a9792f', '#3f70b4'][index % 3];
      const data = numeric(item.values);
      const points = data.map((value, pointIndex) => [x(pointIndex), y(value)]);
      const line = smoothPath(points);
      const id = nextId('area');
      const area = `${line} L${x(data.length - 1)},${pad.top + innerH} L${x(0)},${pad.top + innerH} Z`;
      return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="${index === 0 ? 0.22 : 0.08}"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient></defs>
        ${index === 0 ? `<path d="${area}" fill="url(#${id})"/>` : ''}
        <path d="${line}" fill="none" stroke="${color}" stroke-width="${index === 0 ? 1.7 : 1.2}" stroke-linecap="round" opacity="${
          index === 0 ? 0.95 : 0.65
        }"/>
        ${
          data.length
            ? `<circle cx="${x(data.length - 1)}" cy="${y(data[data.length - 1])}" r="2.6" fill="${color}"/>
               <circle cx="${x(data.length - 1)}" cy="${y(data[data.length - 1])}" r="6" fill="none" stroke="${color}" stroke-opacity=".22"/>`
            : ''
        }`;
    })
    .join('');

  return `<div class="chart-shell">
    <div class="chart-legend">${drawable
      .map(
        (item, index) =>
          `<span class="legend-item"><i class="legend-line ${
            ['', 'amber', 'blue'][index] ?? ''
          }" style="background:${item.color ?? ['#0b7a5e', '#a9792f', '#3f70b4'][index % 3]}"></i>${esc(
            item.name ?? ''
          )}</span>`
      )
      .join('')}</div>
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="经营趋势图">
      ${grid}${xLabels}${paths}
    </svg>
  </div>`;
}

export function funnel(data = {}) {
  const rows = [
    { label: '曝光', value: data.impressions ?? 0, tone: 'blue' },
    { label: '停留', value: data.stays ?? 0, tone: 'blue' },
    { label: '互动', value: data.interactions ?? 0, tone: 'amber' },
    { label: '加购', value: data.addCart ?? 0, tone: 'amber' },
    { label: '成交', value: data.orders ?? 0, tone: 'mint' }
  ];
  const top = Math.max(rows[0].value, 1);
  return `<div class="waterfall">${rows
    .map((row, index) => {
      const prev = index === 0 ? null : rows[index - 1].value;
      const rate = prev ? (row.value / Math.max(prev, 1)) * 100 : 100;
      return `<div class="waterfall-row">
        <span class="waterfall-name">${esc(row.label)}</span>
        <span class="waterfall-track"><i style="width:${Math.max(2, (row.value / top) * 100).toFixed(
          2
        )}%;background:${row.tone === 'mint' ? 'linear-gradient(90deg,rgba(11,122,94,.2),rgba(11,122,94,.72))' : row.tone === 'amber' ? 'linear-gradient(90deg,rgba(169,121,47,.18),rgba(169,121,47,.62))' : 'linear-gradient(90deg,rgba(63,112,180,.18),rgba(63,112,180,.56))'}"></i></span>
        <span class="waterfall-ms">${row.value.toLocaleString('zh-CN')}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding-left:130px;font-family:var(--font-mono);font-size:6.5px;color:var(--faint);margin-top:-5px;margin-bottom:3px">
        <span>${index === 0 ? '入口样本' : `层间转化 ${rate.toFixed(1)}%`}</span>
        <span>占总曝光 ${((row.value / top) * 100).toFixed(1)}%</span>
      </div>`;
    })
    .join('')}</div>`;
}

export function waterfall(spans = []) {
  if (!spans.length) return `<div class="chart-empty">暂无 Span 记录</div>`;
  const total = Math.max(...spans.map((span) => Number(span.durationMs) || 0), 0.01);
  return `<div class="waterfall">${spans
    .map(
      (span) => `<div class="waterfall-row">
        <span class="waterfall-name" title="${esc(span.name)}">${esc(span.name)}</span>
        <span class="waterfall-track"><i style="width:${Math.max(2, ((Number(span.durationMs) || 0) / total) * 100).toFixed(
          2
        )}%;${span.status === 'error' ? 'background:linear-gradient(90deg,rgba(184,66,82,.2),rgba(184,66,82,.62))' : ''}"></i></span>
        <span class="waterfall-ms">${(Number(span.durationMs) || 0).toFixed(1)}ms</span>
      </div>`
    )
    .join('')}</div>`;
}

const NODE_STYLE = {
  context: { stroke: 'rgba(86,107,96,.42)', fill: 'rgba(86,107,96,.07)', text: '#33453d', tag: '#5b6f64' },
  treatment: { stroke: 'rgba(169,121,47,.5)', fill: 'rgba(169,121,47,.09)', text: '#7a551c', tag: '#996b2b' },
  mediator: { stroke: 'rgba(63,112,180,.46)', fill: 'rgba(63,112,180,.07)', text: '#2f5a95', tag: '#3f70b4' },
  outcome: { stroke: 'rgba(11,122,94,.5)', fill: 'rgba(11,122,94,.07)', text: '#0a5c47', tag: '#0b7a5e' }
};

export function causalDag(dag) {
  if (!dag?.nodes?.length) return `<div class="chart-empty">复盘完成后生成因果图</div>`;
  const columns = { context: 0, treatment: 1, mediator: 2, outcome: 3 };
  const buckets = {};
  for (const node of dag.nodes) {
    const key = columns[node.type] ?? 0;
    (buckets[key] ??= []).push(node);
  }
  const width = 820;
  const height = 286;
  const colX = [64, 258, 472, 670];
  const nodeW = 132;
  const nodeH = 52;
  const positions = new Map();
  for (const [colIndex, nodes] of Object.entries(buckets)) {
    const x = colX[Number(colIndex)] ?? 64;
    const gap = 28;
    const block = nodes.length * nodeH + (nodes.length - 1) * gap;
    const startY = (height - 34 - block) / 2 + 6;
    nodes.forEach((node, index) => {
      positions.set(node.id, {
        x,
        y: startY + index * (nodeH + gap),
        w: nodeW,
        h: nodeH,
        node
      });
    });
  }
  const marker = nextId('arrow');
  const edges = (dag.edges ?? [])
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      const mid = (x1 + x2) / 2;
      const labelX = mid;
      const labelY = Math.min(y1, y2) - 6 + Math.abs(y1 - y2) * 0.08;
      return `<path d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 5},${y2}" fill="none" stroke="rgba(86,116,100,.34)" stroke-width="1" marker-end="url(#${marker})"/>
        <text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="6.5" font-family="monospace" fill="rgba(86,107,96,.8)">${esc(
          edge.label ?? ''
        )}</text>`;
    })
    .join('');

  const nodes = [...positions.values()]
    .map(({ x, y, w, h, node }) => {
      const style = NODE_STYLE[node.type] ?? NODE_STYLE.context;
      return `<g>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1"/>
        <text x="${x + 12}" y="${y + 19}" font-size="9.5" fill="${style.text}" font-family="sans-serif">${esc(
          node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label
        )}</text>
        <text x="${x + 12}" y="${y + 34}" font-size="6.5" font-family="monospace" fill="${style.tag}" opacity=".7">${esc(
          node.type.toUpperCase()
        )}</text>
        <text x="${x + 12}" y="${y + 46}" font-size="6.2" font-family="monospace" fill="rgba(86,107,96,.72)">${esc(
          String(node.note ?? '').slice(0, 20)
        )}</text>
      </g>`;
    })
    .join('');

  return `<div class="dag-wrap"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="因果图">
    <defs><marker id="${marker}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="rgba(86,116,100,.5)"/>
    </marker></defs>
    <text x="${colX[0]}" y="18" font-size="6.5" font-family="monospace" fill="rgba(86,107,96,.72)">CONTEXT</text>
    <text x="${colX[1]}" y="18" font-size="6.5" font-family="monospace" fill="rgba(153,107,43,.85)">TREATMENT</text>
    <text x="${colX[2]}" y="18" font-size="6.5" font-family="monospace" fill="rgba(63,112,180,.8)">MEDIATOR</text>
    <text x="${colX[3]}" y="18" font-size="6.5" font-family="monospace" fill="rgba(11,122,94,.8)">OUTCOME</text>
    ${edges}${nodes}
  </svg></div>`;
}

export function heatCell(mean, best) {
  const heat = Math.min(0.26, Math.max(0.015, mean * 0.3));
  return { style: `--heat:${heat.toFixed(3)}`, best };
}

export function legendLine(label, color) {
  return `<span class="legend-item"><i class="legend-line" style="background:${color}"></i>${esc(label)}</span>`;
}
