// sha256.js — SHA-256 primitives, plus a double-SHA reference and the
// midstate helper used by the mining hot-loop. No DOM; runs in worker + main.
//
// Correctness is verified at runtime by the self-test in app.js against the
// Bitcoin genesis block and block 125552 (see test vectors there).

export const H0 = new Int32Array([
  0x6a09e667 | 0, 0xbb67ae85 | 0, 0x3c6ef372 | 0, 0xa54ff53a | 0,
  0x510e527f | 0, 0x9b05688c | 0, 0x1f83d9ab | 0, 0x5be0cd19 | 0,
]);

export const K = new Int32Array([
  0x428a2f98|0, 0x71374491|0, 0xb5c0fbcf|0, 0xe9b5dba5|0, 0x3956c25b|0, 0x59f111f1|0, 0x923f82a4|0, 0xab1c5ed5|0,
  0xd807aa98|0, 0x12835b01|0, 0x243185be|0, 0x550c7dc3|0, 0x72be5d74|0, 0x80deb1fe|0, 0x9bdc06a7|0, 0xc19bf174|0,
  0xe49b69c1|0, 0xefbe4786|0, 0x0fc19dc6|0, 0x240ca1cc|0, 0x2de92c6f|0, 0x4a7484aa|0, 0x5cb0a9dc|0, 0x76f988da|0,
  0x983e5152|0, 0xa831c66d|0, 0xb00327c8|0, 0xbf597fc7|0, 0xc6e00bf3|0, 0xd5a79147|0, 0x06ca6351|0, 0x14292967|0,
  0x27b70a85|0, 0x2e1b2138|0, 0x4d2c6dfc|0, 0x53380d13|0, 0x650a7354|0, 0x766a0abb|0, 0x81c2c92e|0, 0x92722c85|0,
  0xa2bfe8a1|0, 0xa81a664b|0, 0xc24b8b70|0, 0xc76c51a3|0, 0xd192e819|0, 0xd6990624|0, 0xf40e3585|0, 0x106aa070|0,
  0x19a4c116|0, 0x1e376c08|0, 0x2748774c|0, 0x34b0bcb5|0, 0x391c0cb3|0, 0x4ed8aa4a|0, 0x5b9cca4f|0, 0x682e6ff3|0,
  0x748f82ee|0, 0x78a5636f|0, 0x84c87814|0, 0x8cc70208|0, 0x90befffa|0, 0xa4506ceb|0, 0xbef9a3f7|0, 0xc67178f2|0,
]);

// Reusable message schedule (module-scoped; each worker has its own module copy).
const W = new Int32Array(64);

// Compress one 512-bit block. `state` (Int32Array[8]) is updated in place;
// `m` holds the 16 big-endian message words for the block.
export function compress(state, m) {
  let a = state[0], b = state[1], c = state[2], d = state[3],
      e = state[4], f = state[5], g = state[6], h = state[7];

  for (let i = 0; i < 16; i++) W[i] = m[i];
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }

  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }

  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

// Compute the SHA-256 midstate after absorbing the first 64-byte block.
export function midstate(first64) {
  const state = H0.slice();
  const m = new Int32Array(16);
  readWordsBE(first64, 0, m, 16);
  compress(state, m);
  return state;
}

function readWordsBE(bytes, off, out, n) {
  for (let i = 0; i < n; i++) {
    const o = off + i * 4;
    out[i] = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) | 0;
  }
}

// ---------------------------------------------------------------------------
// General-purpose reference (used by self-test, verify panel, coinbase/merkle)
// ---------------------------------------------------------------------------

export function sha256(bytes) {
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // 64-bit big-endian length in the last 8 bytes.
  const lenOff = padded.length - 4;
  padded[lenOff] = (bitLen >>> 24) & 0xff;
  padded[lenOff + 1] = (bitLen >>> 16) & 0xff;
  padded[lenOff + 2] = (bitLen >>> 8) & 0xff;
  padded[lenOff + 3] = bitLen & 0xff;

  const state = H0.slice();
  const m = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    readWordsBE(padded, off, m, 16);
    compress(state, m);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (state[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (state[i] >>> 8) & 0xff;
    out[i * 4 + 3] = state[i] & 0xff;
  }
  return out;
}

// Double SHA-256, as used everywhere in Bitcoin.
export function sha256d(bytes) {
  return sha256(sha256(bytes));
}
