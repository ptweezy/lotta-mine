// miner.js — manages the pool of Web Workers on the main thread.
//
// Splits the 2^32 nonce space across cores, aggregates hash counts into a
// hashrate, and keeps the session's best (lowest) hash. Every "best" candidate
// is re-hashed through the full reference implementation (via the `verify`
// callback) so the headline number on screen is always independently checkable.

const NONCE_SPACE = 0x100000000; // 2^32

export class Miner {
  constructor(opts) {
    this.workerUrl = opts.workerUrl;
    this.verify = opts.verify;        // (job, nonce) -> {hash, difficulty, header}
    this.on = {
      best: opts.onBest || (() => {}),
      share: opts.onShare || (() => {}),
      block: opts.onBlock || (() => {}),
      exhausted: opts.onExhausted || (() => {}),
    };

    this.workers = [];
    this.job = null;
    this.totalHashes = 0;
    this.startedAt = 0;
    this.bestHv0 = 0xffffffff;
    this.bestHv1 = 0xffffffff;
    this.best = null;                 // {hash, difficulty, nonce, jobId}
    this.exhaustedCount = 0;
  }

  get running() { return this.workers.length > 0 && this.job !== null; }

  // Clear all per-session counters so each Start shows fresh numbers.
  reset() {
    this.totalHashes = 0;
    this.startedAt = performance.now();
    this.bestHv0 = 0xffffffff;
    this.bestHv1 = 0xffffffff;
    this.best = null;
  }

  setWorkerCount(n) {
    n = Math.max(1, n | 0);
    this.terminate();
    for (let i = 0; i < n; i++) {
      const w = new Worker(this.workerUrl, { type: 'module' });
      w.onmessage = (e) => this._onWorkerMessage(e.data);
      this.workers.push(w);
    }
    if (this.job) this._dispatch();
  }

  setJob(job) {
    this.job = job;
    this.exhaustedCount = 0;
    if (!this.startedAt) this.startedAt = performance.now();
    this._dispatch();
  }

  // Re-send the current job with a fresh nonce-space partition (used after the
  // space is exhausted, e.g. in long-running benchmark mode).
  rearm() {
    if (this.job) this._dispatch();
  }

  stop() {
    for (const w of this.workers) w.postMessage({ type: 'stop' });
    this.job = null;
  }

  terminate() {
    for (const w of this.workers) { try { w.terminate(); } catch {} }
    this.workers = [];
  }

  _dispatch() {
    const n = this.workers.length;
    if (!n || !this.job) return;
    const span = Math.floor(NONCE_SPACE / n);
    for (let i = 0; i < n; i++) {
      const start = i * span;
      const end = i === n - 1 ? NONCE_SPACE : start + span;
      this.workers[i].postMessage({
        type: 'job',
        jobId: this.job.jobId,
        header80: this.job.header80.buffer.slice(0),
        targetShare: this.job.targetShare,
        targetBlock: this.job.targetBlock,
        startNonce: start,
        endNonce: end,
        bestHv0: 0xffffffff,
        bestHv1: 0xffffffff,
        bestNonce: 0,
      });
    }
  }

  _onWorkerMessage(msg) {
    if (!this.job || msg.jobId !== this.job.jobId) {
      // Stale message from a previous job — only hash counts still matter.
      if (msg.type === 'hashes') this.totalHashes += msg.count;
      return;
    }
    switch (msg.type) {
      case 'hashes':
        this.totalHashes += msg.count;
        break;
      case 'best': {
        if (msg.hv0 < this.bestHv0 || (msg.hv0 === this.bestHv0 && msg.hv1 < this.bestHv1)) {
          this.bestHv0 = msg.hv0; this.bestHv1 = msg.hv1;
          const v = this.verify(this.job, msg.nonce);
          this.best = { ...v, nonce: msg.nonce, jobId: this.job.jobId };
          this.on.best(this.best);
        }
        break;
      }
      case 'share':
        this.on.share(this.job, msg.nonce);
        break;
      case 'block':
        this.on.block(this.job, msg.nonce);
        break;
      case 'exhausted':
        if (++this.exhaustedCount >= this.workers.length) this.on.exhausted(this.job);
        break;
    }
  }

  getStats() {
    const elapsed = this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
    return {
      totalHashes: this.totalHashes,
      elapsed,
      avgHashrate: elapsed > 0 ? this.totalHashes / elapsed : 0,
      best: this.best,
      workers: this.workers.length,
    };
  }
}
