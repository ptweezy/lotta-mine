// util.js — hex/byte-order helpers and Bitcoin difficulty/target math.
// Pure functions, no DOM. Imported by the main thread and the worker.

// ---------------------------------------------------------------------------
// Hex <-> bytes
// ---------------------------------------------------------------------------

const HEX = [];
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

export function hexToBytes(hex) {
  if (hex.length & 1) throw new Error('hex length must be even: ' + hex.length);
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i << 1, 2), 16);
  }
  return out;
}

// Reverse a byte array (returns a copy). Used for display<->internal hash order.
export function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0, j = bytes.length - 1; i < bytes.length; i++, j--) out[i] = bytes[j];
  return out;
}

// Reverse the byte order *within* each 4-byte word, keeping word order.
// This is the transform between a Stratum `prevhash` and the header's prevhash
// field. It is its own inverse (an involution).
export function swap32Words(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    out[i] = bytes[i + 3];
    out[i + 1] = bytes[i + 2];
    out[i + 2] = bytes[i + 1];
    out[i + 3] = bytes[i];
  }
  return out;
}

// Little-endian 4-byte encoding of a uint32 into a Uint8Array at offset.
export function writeUint32LE(buf, off, n) {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >>> 8) & 0xff;
  buf[off + 2] = (n >>> 16) & 0xff;
  buf[off + 3] = (n >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------
// Difficulty / target math
// ---------------------------------------------------------------------------

// "Pool/Bitcoin difficulty 1" target: 0xFFFF * 2^208.
export const DIFF1_TARGET =
  0x00000000ffff0000000000000000000000000000000000000000000000000000n;

// Decode the compact nBits representation into a 32-byte big-endian target.
export function bitsToTarget(bits) {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  let target;
  if (exponent <= 3) {
    target = mantissa >> BigInt(8 * (3 - exponent));
  } else {
    target = mantissa << BigInt(8 * (exponent - 3));
  }
  return bigIntToBytes32BE(target);
}

// Convert a pool share difficulty (float) into a 32-byte big-endian target.
export function difficultyToTarget(difficulty) {
  if (!(difficulty > 0)) difficulty = 1;
  // target = DIFF1_TARGET / difficulty, computed with 1/65536 precision.
  const scaled = BigInt(Math.max(1, Math.round(difficulty * 65536)));
  const target = (DIFF1_TARGET * 65536n) / scaled;
  return bigIntToBytes32BE(target);
}

// How much work did a given hash represent? difficulty = DIFF1_TARGET / hash.
// `hashBE` is the 32-byte big-endian (display-order) hash.
export function hashToDifficulty(hashBE) {
  const value = bytesBEToBigInt(hashBE);
  if (value === 0n) return Infinity;
  // Scale for fractional precision.
  return Number((DIFF1_TARGET * 1000000n) / value) / 1000000;
}

export function bigIntToBytes32BE(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function bytesBEToBigInt(bytes) {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

// Format a hashrate (hashes/sec) as a human-readable string.
export function formatHashrate(hps) {
  if (!isFinite(hps) || hps <= 0) return '0 H/s';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
  let u = 0;
  while (hps >= 1000 && u < units.length - 1) { hps /= 1000; u++; }
  return hps.toFixed(hps >= 100 ? 0 : hps >= 10 ? 1 : 2) + ' ' + units[u];
}

// Format a large difficulty number compactly.
export function formatDifficulty(d) {
  if (!isFinite(d)) return '∞';
  if (d < 1000) return d.toFixed(d < 10 ? 4 : 2);
  const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
  let u = 0;
  while (d >= 1000 && u < units.length - 1) { d /= 1000; u++; }
  return d.toFixed(2) + units[u];
}
