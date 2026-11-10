import { round } from '../agent_core/util.mjs';

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

export class MCPRegistry {
  constructor({ emit = () => {}, approvalValidator = () => false } = {}) {
    this.tools = new Map();
    this.emit = emit;
    this.approvalValidator = approvalValidator;
    this.stats = {};
  }

  register(spec, handler) {
    if (!spec?.name || !spec?.description) throw new Error('Tool spec requires name and description');
    if (typeof handler !== 'function') throw new Error('Tool handler must be a function');
    const normalized = {
      version: '1.0.0',
      riskLevel: 'low',
      category: 'general',
      source: 'builtin',
      requiresApproval: false,
      parameters: { type: 'object', properties: {}, required: [] },
      ...spec
    };
    this.tools.set(normalized.name, { spec: normalized, handler });
    if (!this.stats[normalized.name]) {
      this.stats[normalized.name] = { calls: 0, errors: 0, totalMs: 0, lastCalledAt: null };
    }
    this.emit('tool.registered', { name: normalized.name, spec: normalized });
    return normalized;
  }

  unregister(name) {
    const entry = this.tools.get(name);
    if (!entry) return false;
    if (entry.spec.source === 'builtin') throw new Error('Builtin tools cannot be removed');
    this.tools.delete(name);
    delete this.stats[name];
    this.emit('tool.removed', { name });
    return true;
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  list() {
    return [...this.tools.values()].map(({ spec }) => ({
      ...spec,
      stats: this.stats[spec.name]
    }));
  }

  validateArgs(spec, args) {
    const required = spec.parameters?.required ?? [];
    for (const key of required) {
      if (args[key] == null) throw new Error(`Missing required argument: ${key}`);
    }
    for (const [key, schema] of Object.entries(spec.parameters?.properties ?? {})) {
      const value = args[key];
      if (value == null) continue;
      if (schema.type === 'number' && typeof value !== 'number') throw new Error(`${key} must be number`);
      if (schema.type === 'string' && typeof value !== 'string') throw new Error(`${key} must be string`);
      if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
      if (schema.type === 'array' && !Array.isArray(value)) throw new Error(`${key} must be array`);
    }
  }

  async call(name, args = {}, context = {}) {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Tool not found: ${name}`);
    this.validateArgs(entry.spec, args);
    const ctx = { ...context, approvalId: context.approvalId ?? args.approvalId ?? null };
    if (entry.spec.requiresApproval && !this.approvalValidator(name, ctx)) {
      const error = new Error(`Tool ${name} requires a valid consensus approval`);
      error.code = 'APPROVAL_REQUIRED';
      throw error;
    }
    const started = performance.now();
    const stat = this.stats[name];
    stat.calls += 1;
    stat.lastCalledAt = Date.now();
    try {
      const result = await entry.handler(args, { ...ctx, spec: entry.spec });
      const durationMs = round(performance.now() - started, 2);
      stat.totalMs += durationMs;
      if (!ctx.silent) {
        this.emit('tool.called', {
          name,
          risk: entry.spec.riskLevel,
          durationMs,
          approvalId: ctx.approvalId,
          traceId: ctx.traceId ?? null
        });
      }
      return { ok: true, result, durationMs, tool: name };
    } catch (error) {
      stat.errors += 1;
      this.emit('tool.error', { name, message: error.message, traceId: context.traceId ?? null });
      throw error;
    }
  }

  schemas() {
    return this.list().map(({ name, description, parameters, riskLevel }) => ({
      name,
      description,
      riskLevel,
      inputSchema: parameters
    }));
  }

  snapshot() {
    return this.list()
      .map((tool) => ({
        ...tool,
        riskRank: RISK_ORDER[tool.riskLevel] ?? 0,
        avgMs: tool.stats.calls ? round(tool.stats.totalMs / tool.stats.calls, 2) : 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
