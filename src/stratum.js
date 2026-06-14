// stratum.js — Stratum v1 client spoken over a WebSocket bridge.
//
// Browsers cannot open raw TCP sockets, and Stratum is line-delimited JSON-RPC
// over TCP. So we talk to proxy/stratum_proxy.py, which forwards each JSON line
// to the real pool. This class handles subscribe/authorize/notify/submit and,
// crucially, reconstructs the 80-byte block header from a job — the byte-order
// here is the #1 source of mining bugs, so it is covered by the self-test.

import { sha256d } from './sha256.js';
import {
  hexToBytes, bytesToHex, reverseBytes, swap32Words,
  bitsToTarget, difficultyToTarget, hashToDifficulty,
} from './util.js';

export class StratumClient {
  constructor(opts) {
    this.proxyUrl = opts.proxyUrl;
    this.pool = opts.pool;             // "host:port"
    this.user = opts.user;            // BTC address (.worker optional)
    this.pass = opts.pass || 'x';
    this.suggestDifficulty = opts.suggestDifficulty > 0 ? opts.suggestDifficulty : null;
    this.on = {
      job: opts.onJob || (() => {}),
      status: opts.onStatus || (() => {}),
      result: opts.onResult || (() => {}),
      log: opts.onLog || (() => {}),
    };

    this.ws = null;
    this.buf = '';
    this.nextId = 4;
    this.extranonce1 = '';
    this.extranonce2Size = 4;
    this.difficulty = 1;
    this.subscribed = false;
    this.authorized = false;
    this.jobs = new Map();             // jobId -> job (for share submission)
    this.pendingSubmits = new Map();   // rpc id -> {jobId, nonce}
    this.wantConnected = false;
    this.reconnectTimer = null;
  }

  connect() {
    this.wantConnected = true;
    this._open();
  }

  disconnect() {
    this.wantConnected = false;
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.subscribed = this.authorized = false;
  }

  _open() {
    const url = this.proxyUrl + (this.proxyUrl.includes('?') ? '&' : '?') +
      'pool=' + encodeURIComponent(this.pool);
    this.on.status('connecting');
    this.on.log('connecting to pool ' + this.pool + ' via ' + this.proxyUrl);

    let ws;
    try { ws = new WebSocket(url); } catch (err) { this._fail('bad proxy url: ' + err.message); return; }
    this.ws = ws;
    this.buf = '';

    ws.onopen = () => {
      this.on.status('connected');
      this.on.log('proxy connected — subscribing');
      this._send({ id: 1, method: 'mining.subscribe', params: ['lotta-mine/0.1'] });
    };
    ws.onmessage = (e) => { this.buf += e.data; this._drain(); };
    ws.onerror = () => { this.on.log('websocket error (is the proxy running?)'); };
    ws.onclose = () => {
      this.subscribed = this.authorized = false;
      this.on.status('disconnected');
      if (this.wantConnected) {
        this.on.log('connection closed — retrying in 5s');
        this.reconnectTimer = setTimeout(() => this._open(), 5000);
      }
    };
  }

  _fail(msg) { this.on.log('error: ' + msg); this.on.status('error'); }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj) + '\n');
    }
  }

  _drain() {
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this._handleLine(line);
    }
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.on.log('non-JSON from pool: ' + line); return; }

    // Notifications from the pool (method set, id null).
    if (msg.method) {
      if (msg.method === 'mining.set_difficulty') {
        this.difficulty = msg.params[0];
        this.on.log('pool set share difficulty = ' + this.difficulty);
      } else if (msg.method === 'mining.notify') {
        this._onNotify(msg.params);
      } else if (msg.method === 'mining.set_extranonce') {
        this.extranonce1 = msg.params[0];
        this.extranonce2Size = msg.params[1];
      } else if (msg.method === 'client.show_message') {
        this.on.log('pool message: ' + msg.params[0]);
      }
      return;
    }

    // Responses to our requests.
    if (msg.id === 1) {                    // subscribe
      const r = msg.result;
      if (!r) { this._fail('subscribe rejected: ' + JSON.stringify(msg.error)); return; }
      this.extranonce1 = r[1];
      this.extranonce2Size = r[2];
      this.subscribed = true;
      this.on.log('subscribed — extranonce1=' + this.extranonce1 + ' extranonce2_size=' + this.extranonce2Size);
      this._send({ id: 2, method: 'mining.authorize', params: [this.user, this.pass] });
    } else if (msg.id === 2) {             // authorize
      if (msg.result === true) {
        this.authorized = true;
        this.on.status('mining');
        this.on.log('authorized as ' + this.user + ' — waiting for work');
        // Ask the pool for an easier share target so shares actually land on a
        // phone. The pool may honor it, clamp it to its own minimum, or ignore
        // it — watch the next "set share difficulty" line to see what happened.
        if (this.suggestDifficulty) {
          this._send({ id: 3, method: 'mining.suggest_difficulty', params: [this.suggestDifficulty] });
          this.on.log('requested share difficulty ' + this.suggestDifficulty + ' (pool may clamp to its minimum)');
        }
      } else {
        this._fail('authorize rejected: ' + JSON.stringify(msg.error) + ' (check your address)');
      }
    } else if (msg.id === 3) {             // suggest_difficulty reply (many pools stay silent)
      if (msg.error) this.on.log('pool rejected suggest_difficulty: ' + JSON.stringify(msg.error));
    } else if (this.pendingSubmits.has(msg.id)) {
      const info = this.pendingSubmits.get(msg.id);
      this.pendingSubmits.delete(msg.id);
      this.on.result({ accepted: msg.result === true, error: msg.error, ...info });
    }
  }

  // mining.notify params: [job_id, prevhash, coinb1, coinb2, merkle_branch,
  //                        version, nbits, ntime, clean_jobs]
  _onNotify(p) {
    const raw = {
      jobId: p[0], prevhash: p[1], coinb1: p[2], coinb2: p[3],
      merkleBranch: p[4], version: p[5], nbits: p[6], ntime: p[7], cleanJobs: p[8],
    };
    const extranonce2 = '00'.repeat(this.extranonce2Size); // one e2 gives a full 4G nonce space
    const job = this._buildJob(raw, extranonce2);
    this.jobs.set(job.jobId, job);
    if (this.jobs.size > 8) this.jobs.delete(this.jobs.keys().next().value);
    this.on.log('new job ' + job.jobId + (raw.cleanJobs ? ' (clean)' : '') +
      ' — net diff ' + hashToDifficulty(job.targetBlock).toFixed(0));
    this.on.job(job, raw.cleanJobs);
  }

  _buildJob(raw, extranonce2) {
    // 1. Coinbase = coinb1 + extranonce1 + extranonce2 + coinb2, then its hash.
    const coinbase = hexToBytes(raw.coinb1 + this.extranonce1 + extranonce2 + raw.coinb2);
    let root = sha256d(coinbase);

    // 2. Fold the merkle branch into the coinbase hash to get the merkle root.
    for (const branch of raw.merkleBranch) {
      const cat = new Uint8Array(64);
      cat.set(root, 0);
      cat.set(hexToBytes(branch), 32);
      root = sha256d(cat);
    }

    // 3. Serialize the 80-byte header (see byte-order notes in the README).
    const header = new Uint8Array(80);
    header.set(reverseBytes(hexToBytes(raw.version)), 0);   // version: BE hex -> LE
    header.set(swap32Words(hexToBytes(raw.prevhash)), 4);   // prevhash: 4-byte word swap
    header.set(root, 36);                                   // merkle root: internal order
    header.set(reverseBytes(hexToBytes(raw.ntime)), 68);    // ntime: BE hex -> LE
    header.set(reverseBytes(hexToBytes(raw.nbits)), 72);    // nbits: BE hex -> LE
    // bytes 76..79 (nonce) left zero; the worker fills them.

    return {
      jobId: raw.jobId,
      header80: header,
      targetShare: difficultyToTarget(this.difficulty),
      targetBlock: bitsToTarget(parseInt(raw.nbits, 16)),
      difficulty: this.difficulty,
      extranonce2,
      ntime: raw.ntime,
      nbits: raw.nbits,
      cleanJobs: raw.cleanJobs,
      merkleRoot: bytesToHex(root),
      prevhashDisplay: bytesToHex(reverseBytes(swap32Words(hexToBytes(raw.prevhash)))),
    };
  }

  // Independently recompute the full hash for a found nonce — powers both the
  // pre-submit sanity check and the UI "verify" panel. Returns display hash hex
  // and its difficulty.
  verifyNonce(job, nonce) {
    const header = job.header80.slice();
    header[76] = nonce & 0xff;
    header[77] = (nonce >>> 8) & 0xff;
    header[78] = (nonce >>> 16) & 0xff;
    header[79] = (nonce >>> 24) & 0xff;
    const hashBE = reverseBytes(sha256d(header)); // display order
    return {
      header: bytesToHex(header),
      hash: bytesToHex(hashBE),
      difficulty: hashToDifficulty(hashBE),
    };
  }

  submitShare(job, nonce) {
    const id = this.nextId++;
    const nonceHex = (nonce >>> 0).toString(16).padStart(8, '0');
    this.pendingSubmits.set(id, { jobId: job.jobId, nonce, difficulty: this.verifyNonce(job, nonce).difficulty });
    this._send({
      id, method: 'mining.submit',
      params: [this.user, job.jobId, job.extranonce2, job.ntime, nonceHex],
    });
    return id;
  }
}
