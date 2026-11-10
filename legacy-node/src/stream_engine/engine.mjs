import { percentile, round } from '../agent_core/util.mjs';

export class StreamEngine {
  constructor({
    windowMs = 80,
    maxBatch = 32,
    backpressureQueue = 48,
    handler,
    emit = () => {}
  } = {}) {
    this.windowMs = windowMs;
    this.maxBatch = maxBatch;
    this.backpressureQueue = backpressureQueue;
    this.handler = handler;
    this.emit = emit;
    this.queue = [];
    this.timer = null;
    this.processing = false;
    this.latencies = [];
    this.metrics = {
      total: 0,
      processed: 0,
      dropped: 0,
      batches: 0,
      errors: 0,
      peakQueue: 0,
      lastFlushAt: null
    };
  }

  ingest(item) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.metrics.total += 1;
      if (item.priority === 'low' && this.queue.length >= this.backpressureQueue) {
        this.metrics.dropped += 1;
        this.recordLatency(performance.now() - t0 + 0.05);
        this.emit('stream.backpressure', {
          dropped: this.metrics.dropped,
          queue: this.queue.length,
          reason: 'low-value under pressure'
        });
        resolve({ dropped: true, item, latencyMs: 0.1 });
        return;
      }
      this.queue.push({ item, t0, resolve });
      this.metrics.peakQueue = Math.max(this.metrics.peakQueue, this.queue.length);
      if (this.queue.length >= this.maxBatch) {
        void this.flush();
      } else {
        this.schedule();
      }
    });
  }

  schedule() {
    if (this.timer || this.processing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.windowMs);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.maxBatch);
      const started = performance.now();
      try {
        const results = await this.handler(
          batch.map((b) => b.item),
          { batchSize: batch.length }
        );
        const now = performance.now();
        batch.forEach((entry, index) => {
          const latency = now - entry.t0;
          this.recordLatency(latency);
          this.metrics.processed += 1;
          entry.resolve({
            dropped: false,
            item: entry.item,
            result: results?.[index] ?? null,
            latencyMs: round(latency, 2)
          });
        });
      } catch (error) {
        this.metrics.errors += 1;
        batch.forEach((entry) => {
          this.recordLatency(performance.now() - entry.t0);
          entry.resolve({ dropped: false, item: entry.item, result: null, error: error.message });
        });
      }
      this.metrics.batches += 1;
      this.metrics.lastFlushAt = Date.now();
      this.metrics.batchLatencyMs = round(performance.now() - started, 2);
      this.emit('stream.metrics', this.snapshot());
    }
    this.processing = false;
    if (this.queue.length) this.schedule();
  }

  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > 4000) this.latencies.splice(0, this.latencies.length - 4000);
  }

  snapshot() {
    const p50 = percentile(this.latencies, 50);
    const p95 = percentile(this.latencies, 95);
    const p99 = percentile(this.latencies, 99);
    return {
      ...this.metrics,
      p50: round(p50, 2),
      p95: round(p95, 2),
      p99: round(p99, 2),
      queue: this.queue.length,
      windowMs: this.windowMs,
      maxBatch: this.maxBatch,
      backpressureQueue: this.backpressureQueue,
      measured: true
    };
  }

  resetMetrics() {
    this.latencies = [];
    this.metrics = { total: 0, processed: 0, dropped: 0, batches: 0, errors: 0, peakQueue: 0, lastFlushAt: null };
  }
}
