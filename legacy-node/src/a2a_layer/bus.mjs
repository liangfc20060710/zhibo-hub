import { validateEnvelope } from './envelope.mjs';

export class MessageBus {
  constructor({ emit = () => {}, maxLog = 600 } = {}) {
    this.agents = new Map();
    this.log = [];
    this.collectors = new Set();
    this.emit = emit;
    this.maxLog = maxLog;
    this.counts = { sent: 0, broadcast: 0, rerouted: 0, dropped: 0 };
  }

  register(agent) {
    this.agents.set(agent.id, agent);
  }

  unregister(agentId) {
    this.agents.delete(agentId);
  }

  get(id) {
    return this.agents.get(id) ?? null;
  }

  list() {
    return [...this.agents.values()];
  }

  resolveTargets(env) {
    if (env.receiver === '*' || env.receiver == null) {
      return this.list().filter((a) => a.id !== env.sender && a.status === 'active');
    }
    const direct = this.agents.get(env.receiver);
    const logical = direct ?? this.list().find((a) => a.logicalRole === env.receiver);
    if (!logical) return [];
    if (logical.status === 'active') return [logical];
    if (logical.status === 'standby') {
      const activeReplica = this.list().find(
        (a) => a.logicalRole === logical.logicalRole && a.status === 'active'
      );
      return activeReplica ? [activeReplica] : [];
    }
    const replica = this.list().find(
      (a) => a.logicalRole === logical.logicalRole && a.id !== logical.id && a.status === 'active'
    );
    return replica ? [replica] : [];
  }

  async send(env) {
    if (!validateEnvelope(env)) throw new Error('Invalid A2A envelope');
    const targets = this.resolveTargets(env);
    const isBroadcast = env.receiver === '*' || env.receiver == null;
    const record = {
      ...env,
      deliveredTo: targets.map((a) => a.id),
      broadcast: isBroadcast
    };
    this.log.push(record);
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
    this.counts.sent += 1;
    if (isBroadcast) this.counts.broadcast += 1;

    if (!targets.length) {
      const expected = this.agents.get(env.receiver);
      if (expected && expected.status !== 'active') {
        this.counts.dropped += 1;
        this.emit('a2a.unreachable', {
          agent: env.receiver,
          logicalRole: expected.logicalRole,
          envelope: record,
          reason: 'no-active-instance'
        });
      }
      this.collectors.forEach((collector) => collector(record));
      this.emit('envelope', record);
      return record;
    }

    for (const agent of targets) {
      await agent.enqueue(record);
    }
    this.collectors.forEach((collector) => collector(record));
    this.emit('envelope', record);
    return record;
  }

  async broadcast(env) {
    return this.send({ ...env, receiver: '*' });
  }

  logSystem(env, note = '') {
    const record = {
      ...env,
      deliveredTo: [],
      system: true,
      note
    };
    this.log.push(record);
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
    this.counts.sent += 1;
    this.emit('envelope', record);
    return record;
  }

  collect({ traceId, performative = null, timeoutMs = 260 }) {
    const received = [];
    const collector = (env) => {
      if (env.traceId !== traceId) return;
      if (performative && env.performative !== performative) return;
      if (env.receiver === '*') return;
      received.push(env);
    };
    this.collectors.add(collector);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.collectors.delete(collector);
        resolve(received);
      }, timeoutMs);
    });
  }

  recent(limit = 40) {
    return this.log.slice(-limit).reverse();
  }

  stats() {
    const performatives = {};
    for (const item of this.log) {
      performatives[item.performative] = (performatives[item.performative] ?? 0) + 1;
    }
    return {
      ...this.counts,
      logSize: this.log.length,
      performatives,
      agents: this.list().map((a) => ({ id: a.id, status: a.status }))
    };
  }
}
