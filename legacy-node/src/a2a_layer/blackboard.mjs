export class Blackboard {
  constructor({ emit = () => {} } = {}) {
    this.state = {
      stage: 'prep',
      sessionId: null,
      currentProduct: null,
      viewers: 0,
      peakViewers: 0,
      gmv: 0,
      orders: 0,
      interactionRate: 0,
      cvr: 0,
      sentiment: 0.82,
      stockRisk: 0,
      couponActive: false,
      riskLevel: 'low',
      latencyP99: 0,
      updatedAt: Date.now()
    };
    this.version = 0;
    this.emit = emit;
    this.history = [];
  }

  update(patch, { silent = false } = {}) {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    this.version += 1;
    const entry = { version: this.version, patch, at: Date.now() };
    this.history.push(entry);
    if (this.history.length > 400) this.history.shift();
    if (!silent) this.emit('blackboard', this.snapshot());
    return this.state;
  }

  get(key) {
    return this.state[key];
  }

  snapshot() {
    return { ...this.state, version: this.version };
  }

  recent(limit = 12) {
    return this.history.slice(-limit).reverse();
  }
}
