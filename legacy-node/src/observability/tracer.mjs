import { traceCode, uid, round } from '../agent_core/util.mjs';

export class Tracer {
  constructor({ emit = () => {}, maxTraces = 80 } = {}) {
    this.emit = emit;
    this.maxTraces = maxTraces;
    this.traces = new Map();
    this.order = [];
  }

  start(name, meta = {}) {
    const trace = {
      id: traceCode(),
      name,
      meta,
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      status: 'running',
      spans: []
    };
    this.traces.set(trace.id, trace);
    this.order.unshift(trace.id);
    if (this.order.length > this.maxTraces) {
      const removed = this.order.pop();
      this.traces.delete(removed);
    }
    return trace;
  }

  span(trace, name, agent, meta = {}) {
    const span = {
      id: uid('SPN'),
      name,
      agent,
      startedAt: Date.now(),
      durationMs: null,
      status: 'running',
      meta
    };
    trace.spans.push(span);
    const begin = performance.now();
    return {
      span,
      end: (status = 'ok', extra = {}) => {
        span.durationMs = round(performance.now() - begin, 2);
        span.status = status;
        span.meta = { ...span.meta, ...extra };
      }
    };
  }

  async track(trace, name, agent, fn, meta = {}) {
    const handle = this.span(trace, name, agent, meta);
    try {
      const result = await fn();
      handle.end('ok');
      return result;
    } catch (error) {
      handle.end('error', { error: error.message });
      throw error;
    }
  }

  finish(trace, status = 'ok', summary = null) {
    trace.finishedAt = Date.now();
    trace.durationMs = trace.finishedAt - trace.startedAt;
    trace.status = status;
    if (summary) trace.summary = summary;
    this.emit('trace', this.summary(trace));
    return trace;
  }

  get(id) {
    return this.traces.get(id) ?? null;
  }

  import(trace) {
    if (!trace?.id) return null;
    const normalized = {
      status: 'ok',
      spans: [],
      durationMs: trace.durationMs ?? 0,
      startedAt: trace.startedAt ? new Date(trace.startedAt).getTime() : Date.now(),
      finishedAt: trace.finishedAt ? new Date(trace.finishedAt).getTime() : Date.now(),
      ...trace
    };
    this.traces.set(normalized.id, normalized);
    this.order.push(normalized.id);
    return normalized;
  }

  summary(trace) {
    if (!trace) return null;
    return {
      id: trace.id,
      name: trace.name,
      meta: trace.meta,
      startedAt: trace.startedAt,
      finishedAt: trace.finishedAt,
      durationMs: trace.durationMs,
      status: trace.status,
      summary: trace.summary ?? null,
      spans: trace.spans
    };
  }

  list(limit = 20) {
    return this.order
      .slice(0, limit)
      .map((id) => this.summary(this.traces.get(id)))
      .filter(Boolean);
  }
}
