// Core correctness tests — run with `npm test` (Node) and mirrored by the
// in-browser self-test in app.js. Vectors independently confirmed with Python.
import { H0, compress, midstate, sha256d } from '../src/sha256.js';
import {
  hexToBytes, bytesToHex, reverseBytes, swap32Words, writeUint32LE,
  bitsToTarget, difficultyToTarget, hashToDifficulty,
} from '../src/util.js';
import { StratumClient } from '../src/stratum.js';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fails++;
};

function buildHeader(version, prevDisp, merkleDisp, time, bits, nonce) {
  const h = new Uint8Array(80);
  h.set(reverseBytes(hexToBytes(version)), 0);
  h.set(reverseBytes(hexToBytes(prevDisp)), 4);
  h.set(reverseBytes(hexToBytes(merkleDisp)), 36);
  writeUint32LE(h, 68, time);
  writeUint32LE(h, 72, bits);
  writeUint32LE(h, 76, nonce);
  return h;
}

// Reproduce the worker's exact midstate double-hash to validate it vs reference.
const bswap = (n) => (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | (n >>> 24)) >>> 0;
function workerDigest(header) {
  const mid = midstate(header.subarray(0, 64));
  const m2 = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const o = 64 + i * 4;
    m2[i] = ((header[o] << 24) | (header[o + 1] << 16) | (header[o + 2] << 8) | header[o + 3]) | 0;
  }
  m2[4] = 0x80000000 | 0; m2[15] = 640;
  const s1 = mid.slice(); compress(s1, m2);
  const m3 = new Int32Array(16);
  for (let i = 0; i < 8; i++) m3[i] = s1[i];
  m3[8] = 0x80000000 | 0; m3[15] = 256;
  const s2 = H0.slice(); compress(s2, m3);
  const d = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    d[i * 4] = (s2[i] >>> 24) & 0xff; d[i * 4 + 1] = (s2[i] >>> 16) & 0xff;
    d[i * 4 + 2] = (s2[i] >>> 8) & 0xff; d[i * 4 + 3] = s2[i] & 0xff;
  }
  return d;
}

console.log('sha256d reference vs known block hashes');
const genesis = buildHeader('00000001', '0'.repeat(64),
  '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
  1231006505, 0x1d00ffff, 2083236893);
check('genesis block 0',
  bytesToHex(reverseBytes(sha256d(genesis))) === '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
const b125552 = buildHeader('00000001',
  '00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81',
  '2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3',
  1305998791, 0x1a44b9f2, 2504433986);
check('block 125552',
  bytesToHex(reverseBytes(sha256d(b125552))) === '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d');

console.log('worker midstate path == reference hasher');
check('genesis', bytesToHex(workerDigest(genesis)) === bytesToHex(sha256d(genesis)));
check('block 125552', bytesToHex(workerDigest(b125552)) === bytesToHex(sha256d(b125552)));
let randomOk = true;
for (let t = 0; t < 1000; t++) {
  const h = new Uint8Array(80);
  for (let i = 0; i < 80; i++) h[i] = (Math.random() * 256) | 0;
  if (bytesToHex(workerDigest(h)) !== bytesToHex(sha256d(h))) { randomOk = false; break; }
}
check('1000 random headers', randomOk);

console.log('stratum job construction (real StratumClient code)');
const probe = new StratumClient({ proxyUrl: '', pool: '', user: '' });
probe.extranonce1 = 'deadbeef'; probe.difficulty = 1;
const job = probe._buildJob({
  jobId: 't', version: '00000001', prevhash: '0'.repeat(64),
  coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
  coinb2: 'ffffffff0100f2052a010000001976a914000000000000000000000000000000000000000088ac00000000',
  merkleBranch: ['aa'.repeat(32), 'bb'.repeat(32)],
  nbits: '1d00ffff', ntime: '495fab29', cleanJobs: true,
}, '00000000');
check('coinbase + merkle root',
  job.merkleRoot === '3d578173a0b2046dc54252044e52ab24d8a7c01e1308637f69f8948754449559');
check('prevhash word-swap',
  bytesToHex(swap32Words(hexToBytes('ab02cd818b9e567ee21793cddef299feb29ad444a41b85b8000008a300000000'))) ===
  bytesToHex(reverseBytes(hexToBytes('00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81'))));

console.log('difficulty / target math');
check('bitsToTarget(0x1d00ffff) == difficulty-1 target',
  bytesToHex(bitsToTarget(0x1d00ffff)) === '00000000ffff' + '0'.repeat(52));
check('difficultyToTarget(1) == difficulty-1 target',
  bytesToHex(difficultyToTarget(1)) === '00000000ffff' + '0'.repeat(52));
check('hashToDifficulty of diff-1 target ~= 1',
  Math.abs(hashToDifficulty(bitsToTarget(0x1d00ffff)) - 1) < 1e-6);
check('difficultyToTarget(1024) is 1024x smaller',
  hashToDifficulty(difficultyToTarget(1024)) > 1023.9 && hashToDifficulty(difficultyToTarget(1024)) < 1024.1);

console.log('end-to-end mining loop finds a real sub-target hash');
const target = difficultyToTarget(0.0005);
const tw0 = ((target[0] << 24) | (target[1] << 16) | (target[2] << 8) | target[3]) >>> 0;
let found = -1;
const mh = genesis.slice();
for (let n = 0; n < 5000000; n++) {
  writeUint32LE(mh, 76, n);
  const d = workerDigest(mh);
  const msw = ((d[31] << 24) | (d[30] << 16) | (d[29] << 8) | d[28]) >>> 0; // most-significant 32 bits of LE value
  if (msw <= tw0) { found = n; break; }
}
let hashBE = '';
if (found >= 0) { writeUint32LE(mh, 76, found); hashBE = bytesToHex(reverseBytes(workerDigest(mh))); }
check('found nonce below share target', found >= 0 && hashBE.startsWith('0000'), found >= 0 ? 'nonce=' + found + ' hash=' + hashBE : '');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
