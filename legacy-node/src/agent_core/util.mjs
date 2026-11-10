import crypto from 'node:crypto';

let seq = 0;

export function uid(prefix = 'ID') {
  seq += 1;
  return `${prefix}-${seq.toString(36).padStart(3, '0')}-${crypto.randomBytes(2).toString('hex')}`;
}

export function traceCode() {
  return `TRC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function round(n, digits = 1) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function mean(list) {
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

export function percentile(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function twoProportionTest({ successA, totalA, successB, totalB }) {
  const pA = totalA ? successA / totalA : 0;
  const pB = totalB ? successB / totalB : 0;
  const diff = pA - pB;
  const se = Math.sqrt((pA * (1 - pA)) / Math.max(totalA, 1) + (pB * (1 - pB)) / Math.max(totalB, 1));
  const z = se === 0 ? 0 : diff / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const margin = 1.96 * se;
  return {
    rateA: pA,
    rateB: pB,
    diff,
    se,
    z,
    pValue,
    ci95: [diff - margin, diff + margin],
    relative: pB ? diff / pB : 0
  };
}

export function nowMs() {
  return Date.now();
}

export function formatTimestamp(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}
