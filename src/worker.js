// worker.js — the mining hot-loop. One of these runs per CPU core.
//
// Given an 80-byte header template and a nonce range, it iterates the nonce
// computing sha256d(header) and looks for hashes at or below the share/block
// targets. The first 64 bytes never change while the nonce moves, so we absorb
// them once (the "midstate") and only recompute the final two blocks per nonce.

import { H0, compress, midstate } from './sha256.js';

const bswap = (n) =>
  (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | (n >>> 24)) >>> 0;

// Top 32 bits of a 32-byte big-endian target.
const top32 = (t) => ((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0;

// Lexicographic compare: is the result hash <= targetBE (both 256-bit)?
// Result words are SHA-256 state words; big-endian hash byte k*4..k*4+3 come
// from bswap(state[7-k]). Only called for rare candidate nonces.
function meetsTarget(state, targetBE) {
  for (let k = 0; k < 8; k++) {
    const w = bswap(state[7 - k]);
    const hb0 = w >>> 24, hb1 = (w >>> 16) & 0xff, hb2 = (w >>> 8) & 0xff, hb3 = w & 0xff;
    const o = k * 4;
    if (hb0 !== targetBE[o]) return hb0 < targetBE[o];
    if (hb1 !== targetBE[o + 1]) return hb1 < targetBE[o + 1];
    if (hb2 !== targetBE[o + 2]) return hb2 < targetBE[o + 2];
    if (hb3 !== targetBE[o + 3]) return hb3 < targetBE[o + 3];
  }
  return true; // exactly equal still meets the target
}

let running = false;
let job = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'job') {
    job = msg;
    if (!running) { running = true; setTimeout(mineChunk, 0); }
  } else if (msg.type === 'stop') {
    running = false;
    job = null;
  }
};

function mineChunk() {
  if (!running || !job) { running = false; return; }

  const header = new Uint8Array(job.header80);
  const mid = midstate(header.subarray(0, 64));
  const shareTarget = job.targetShare;
  const blockTarget = job.targetBlock;
  const shareTw0 = top32(shareTarget);
  const jobId = job.jobId;

  // Second block of the first SHA-256 (header bytes 64..79 + padding).
  const m2 = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const o = 64 + i * 4;
    m2[i] = ((header[o] << 24) | (header[o + 1] << 16) | (header[o + 2] << 8) | header[o + 3]) | 0;
  }
  m2[4] = 0x80000000 | 0;       // padding terminator
  m2[15] = 640;                 // 80-byte message = 640 bits

  // The second SHA-256 hashes the 32-byte first digest (constant padding).
  const m3 = new Int32Array(16);
  m3[8] = 0x80000000 | 0;
  m3[15] = 256;                 // 32-byte message = 256 bits

  const s1 = new Int32Array(8);
  const s2 = new Int32Array(8);

  let nonce = job.startNonce;
  const end = job.endNonce;
  let bestHv0 = job.bestHv0 >>> 0;
  let bestHv1 = job.bestHv1 >>> 0;
  let bestNonce = job.bestNonce | 0;
  let bestDirty = false;

  let done = 0;
  const chunkStart = Date.now();
  let checkIn = 0;

  while (nonce < end) {
    m2[3] = bswap(nonce >>> 0) | 0;

    s1.set(mid);
    compress(s1, m2);

    m3[0] = s1[0]; m3[1] = s1[1]; m3[2] = s1[2]; m3[3] = s1[3];
    m3[4] = s1[4]; m3[5] = s1[5]; m3[6] = s1[6]; m3[7] = s1[7];
    s2.set(H0);
    compress(s2, m3);

    const hv0 = bswap(s2[7]);

    if (hv0 <= bestHv0) {
      const hv1 = bswap(s2[6]);
      if (hv0 < bestHv0 || hv1 < bestHv1) {
        bestHv0 = hv0; bestHv1 = hv1; bestNonce = nonce >>> 0; bestDirty = true;
      }
    }

    if (hv0 <= shareTw0 && meetsTarget(s2, shareTarget)) {
      const isBlock = meetsTarget(s2, blockTarget);
      self.postMessage({ type: isBlock ? 'block' : 'share', jobId, nonce: nonce >>> 0 });
    }

    nonce++;
    done++;

    if ((++checkIn & 0x3fff) === 0 && Date.now() - chunkStart > 80) break;
  }

  if (done) self.postMessage({ type: 'hashes', jobId, count: done });
  if (bestDirty) {
    self.postMessage({ type: 'best', jobId, nonce: bestNonce, hv0: bestHv0, hv1: bestHv1 });
  }

  if (nonce >= end) {
    self.postMessage({ type: 'exhausted', jobId });
    running = false;
    return;
  }

  // Persist progress into the job and yield so messages (stop/new job) deliver.
  job.startNonce = nonce;
  job.bestHv0 = bestHv0; job.bestHv1 = bestHv1; job.bestNonce = bestNonce;
  if (running) setTimeout(mineChunk, 0);
}
