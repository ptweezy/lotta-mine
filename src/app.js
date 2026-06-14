// app.js — UI controller. Wires the self-test, the two mining modes (offline
// Benchmark and live Pool), the live stats/odds, and the verify panel.

import { sha256d } from './sha256.js';
import { StratumClient } from './stratum.js';
import { Miner } from './miner.js';
import {
  hexToBytes, bytesToHex, reverseBytes, swap32Words, writeUint32LE,
  difficultyToTarget, hashToDifficulty, formatHashrate, formatDifficulty,
} from './util.js';

const $ = (id) => document.getElementById(id);

// A representative network difficulty used for the odds estimate when we have
// no live job to read it from (Benchmark mode). Update freely; it's just for
// the "age of the universe" punchline.
const ASSUMED_NET_DIFF = 1.2e14;

// --------------------------------------------------------------------------
// Self-test — proves the SHA-256d core and header construction on THIS device,
// using vectors independently confirmed with Python's hashlib. This is the
// "verifiable output" promise made good before a single hash is mined.
// --------------------------------------------------------------------------

function buildTestHeader({ version, prevhashDisplay, merkleDisplay, time, bits, nonce }) {
  const h = new Uint8Array(80);
  h.set(reverseBytes(hexToBytes(version)), 0);
  h.set(reverseBytes(hexToBytes(prevhashDisplay)), 4);  // display order -> header (full reverse)
  h.set(reverseBytes(hexToBytes(merkleDisplay)), 36);   // display order -> internal order
  writeUint32LE(h, 68, time);
  writeUint32LE(h, 72, bits);
  writeUint32LE(h, 76, nonce);
  return h;
}

function selfTest() {
  const results = [];

  // 1. Genesis block (block 0).
  const genesis = buildTestHeader({
    version: '00000001',
    prevhashDisplay: '0000000000000000000000000000000000000000000000000000000000000000',
    merkleDisplay: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
    time: 1231006505, bits: 0x1d00ffff, nonce: 2083236893,
  });
  results.push(['genesis block',
    bytesToHex(reverseBytes(sha256d(genesis))) ===
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f']);

  // 2. Block 125552 (the classic block-hashing example; non-trivial version/bits/nonce).
  const b125552 = buildTestHeader({
    version: '00000001',
    prevhashDisplay: '00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81',
    merkleDisplay: '2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3',
    time: 1305998791, bits: 0x1a44b9f2, nonce: 2504433986,
  });
  results.push(['block 125552',
    bytesToHex(reverseBytes(sha256d(b125552))) ===
    '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d']);

  // 3. Stratum coinbase + merkle branch, through the REAL client code path.
  const probe = new StratumClient({ proxyUrl: '', pool: '', user: '' });
  probe.extranonce1 = 'deadbeef';
  probe.difficulty = 1;
  const job = probe._buildJob({
    jobId: 't', version: '00000001',
    prevhash: '0000000000000000000000000000000000000000000000000000000000000000',
    coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
    coinb2: 'ffffffff0100f2052a010000001976a914000000000000000000000000000000000000000088ac00000000',
    merkleBranch: ['aa'.repeat(32), 'bb'.repeat(32)],
    nbits: '1d00ffff', ntime: '495fab29', cleanJobs: true,
  }, '00000000');
  results.push(['stratum coinbase+merkle',
    job.merkleRoot === '3d578173a0b2046dc54252044e52ab24d8a7c01e1308637f69f8948754449559']);

  // 4. Stratum prevhash word-swap: applying swap32Words to a real stratum-format
  // prevhash must yield the header's prevhash field (= full reversal of display).
  const stratumPrev = 'ab02cd818b9e567ee21793cddef299feb29ad444a41b85b8000008a300000000';
  const displayPrev = '00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81';
  results.push(['stratum prevhash word-swap',
    bytesToHex(swap32Words(hexToBytes(stratumPrev))) === bytesToHex(reverseBytes(hexToBytes(displayPrev)))]);

  const pass = results.every((r) => r[1]);
  return { pass, results };
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

const verifyNonce = (job, nonce) => {
  const header = job.header80.slice();
  writeUint32LE(header, 76, nonce >>> 0);
  const hashBE = reverseBytes(sha256d(header));
  return { header: bytesToHex(header), hash: bytesToHex(hashBE), difficulty: hashToDifficulty(hashBE) };
};

const state = {
  mode: 'benchmark',
  running: false,
  stratum: null,
  benchSeq: 0,
  accepted: 0,
  rejected: 0,
  blocks: 0,
  netDiff: ASSUMED_NET_DIFF,
  ema: 0,
  lastHashes: 0,
  lastTime: 0,
};

const miner = new Miner({
  workerUrl: new URL('./worker.js', import.meta.url),
  verify: verifyNonce,
  onBest: (best) => {
    // Show the exact header that produced this hash, so Verify stays consistent
    // even after the live job rotates.
    $('v-header').textContent = best.header;
    $('v-hash').textContent = best.hash;
    $('v-nonce').textContent = (best.nonce >>> 0) + ' (0x' + (best.nonce >>> 0).toString(16).padStart(8, '0') + ')';
    $('stat-best').textContent = formatDifficulty(best.difficulty);
  },
  onShare: (job, nonce) => handleShare(job, nonce, false),
  onBlock: (job, nonce) => handleShare(job, nonce, true),
  onExhausted: (job) => {
    if (state.mode === 'benchmark' && state.running) {
      log('nonce space exhausted — rolling a fresh benchmark job', 'warn');
      miner.setJob(makeBenchmarkJob(currentBenchDiff()));
    } else {
      log('nonce space exhausted for job ' + job.jobId + ' — awaiting next job', 'warn');
    }
  },
});

// --------------------------------------------------------------------------
// Share / block handling
// --------------------------------------------------------------------------

function handleShare(job, nonce, isBlock) {
  const v = verifyNonce(job, nonce);
  if (isBlock) {
    state.blocks++;
    log('🎉🎉 BLOCK SOLVED! hash ' + v.hash + ' — submitting!', 'win');
  }
  if (state.mode === 'pool' && state.stratum) {
    log((isBlock ? 'BLOCK ' : 'share ') + 'diff ' + formatDifficulty(v.difficulty) + ' → submitting to pool', isBlock ? 'win' : 'ok');
    state.stratum.submitShare(job, nonce);
  } else {
    // Benchmark mode: no pool, so we verify locally and count it as found.
    state.accepted++;
    log('share found & locally verified · diff ' + formatDifficulty(v.difficulty) + ' · hash ' + v.hash.slice(0, 24) + '…', 'ok');
    updateStats();
  }
}

// --------------------------------------------------------------------------
// Benchmark mode
// --------------------------------------------------------------------------

function currentBenchDiff() {
  const d = parseFloat($('bench-diff').value);
  return d > 0 ? d : 0.01;
}

function makeBenchmarkJob(diff) {
  const header = new Uint8Array(80);
  writeUint32LE(header, 0, 0x20000000);            // version
  crypto.getRandomValues(header.subarray(4, 68));  // random prevhash + merkle root
  writeUint32LE(header, 68, Math.floor(Date.now() / 1000));
  writeUint32LE(header, 72, 0x1700ffff);           // arbitrary bits (unused offline)
  return {
    jobId: 'bench-' + (state.benchSeq++),
    header80: header,
    targetShare: difficultyToTarget(diff),
    targetBlock: difficultyToTarget(state.netDiff),
    difficulty: diff,
    extranonce2: '', ntime: '', nbits: '1700ffff',
  };
}

// --------------------------------------------------------------------------
// Pool mode
// --------------------------------------------------------------------------

function startPool() {
  const address = $('pool-address').value.trim();
  if (!address) { log('enter your Bitcoin payout address first', 'err'); return false; }
  const worker = $('pool-worker').value.trim();
  const suggest = parseFloat($('pool-suggestdiff').value);
  state.stratum = new StratumClient({
    proxyUrl: $('pool-proxy').value.trim(),
    pool: $('pool-host').value.trim(),
    user: worker ? address + '.' + worker : address,
    pass: $('pool-pass').value.trim() || 'x',
    suggestDifficulty: suggest > 0 ? suggest : null,
    onJob: (job) => {
      state.netDiff = hashToDifficulty(job.targetBlock);
      $('v-header').textContent = bytesToHex(job.header80);
      miner.setJob(job);
    },
    onStatus: (s) => setStatus(s),
    onResult: (r) => {
      if (r.accepted) { state.accepted++; log('✓ share ACCEPTED by pool · diff ' + formatDifficulty(r.difficulty), 'ok'); }
      else { state.rejected++; log('✗ share rejected: ' + JSON.stringify(r.error), 'err'); }
      updateStats();
    },
    onLog: (m) => log(m),
  });
  state.stratum.connect();
  return true;
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

function start() {
  if (state.running) return;
  const threads = parseInt($('threads').value, 10);

  // Fresh session counters.
  miner.reset();
  state.accepted = state.rejected = state.blocks = 0;
  state.ema = 0;
  state.lastHashes = 0;
  state.lastTime = performance.now();

  if (state.mode === 'pool') {
    if (!startPool()) return;
  } else {
    state.netDiff = ASSUMED_NET_DIFF;
    setStatus('mining');
    log('benchmark mode · ' + threads + ' thread(s) · synthetic job', 'ok');
  }

  state.running = true;
  miner.setWorkerCount(threads);

  if (state.mode === 'benchmark') {
    const job = makeBenchmarkJob(currentBenchDiff());
    $('v-header').textContent = bytesToHex(job.header80);
    miner.setJob(job);
  }

  $('toggle').textContent = 'Stop mining';
  $('toggle').classList.add('running');
  saveSettings();
}

function stop() {
  state.running = false;
  miner.stop();
  miner.terminate();
  if (state.stratum) { state.stratum.disconnect(); state.stratum = null; }
  setStatus('idle');
  $('toggle').textContent = 'Start mining';
  $('toggle').classList.remove('running');
  log('stopped', 'warn');
}

// --------------------------------------------------------------------------
// Stats + odds
// --------------------------------------------------------------------------

function updateStats() {
  const s = miner.getStats();
  $('stat-hashes').textContent = s.totalHashes.toLocaleString();
  $('stat-elapsed').textContent = formatElapsed(s.elapsed);
  $('stat-shares').textContent = state.accepted + ' / ' + state.rejected;
}

function tick() {
  const now = performance.now();
  const dt = (now - state.lastTime) / 1000;
  if (state.running && dt > 0) {
    const rate = (miner.totalHashes - state.lastHashes) / dt;
    state.ema = state.ema === 0 ? rate : state.ema * 0.6 + rate * 0.4;
    state.lastHashes = miner.totalHashes;
    state.lastTime = now;
    $('hashrate').textContent = formatHashrate(state.ema);
    $('odds').innerHTML = oddsText(state.ema, state.netDiff);
  } else if (!state.running) {
    $('hashrate').textContent = formatHashrate(0);
  }
  updateStats();
}

function oddsText(hashrate, netDiff) {
  if (!(hashrate > 0)) return 'Estimating…';
  const hashesPerBlock = netDiff * 4294967296;       // difficulty × 2^32
  const seconds = hashesPerBlock / hashrate;          // expected seconds per block found
  const years = seconds / (365.25 * 24 * 3600);
  const ageUniverse = 1.38e10;
  let t;
  if (years < 1) t = '≈ ' + formatElapsed(seconds);
  else if (years < 1e6) t = '≈ ' + sig(years) + ' years';
  else t = '≈ ' + sci(years) + ' years (~' + sig(years / ageUniverse) + '× the age of the universe)';
  return 'Expected time to solve a block at this rate: <strong>' + t + '</strong>';
}

const sig = (n) => n >= 1000 ? formatDifficulty(n) : n.toFixed(n < 10 ? 1 : 0);
const sci = (n) => n.toExponential(1).replace('e+', '×10^');

function formatElapsed(sec) {
  sec = Math.floor(sec);
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
}

// --------------------------------------------------------------------------
// Verify panel
// --------------------------------------------------------------------------

function runVerify() {
  const out = $('verify-out');
  const best = miner.best;
  if (!best) { out.textContent = 'Mine for a moment first — no best hash yet.'; out.className = 'verify-out'; return; }
  // Recompute sha256d independently from the exact header that produced `best`.
  const recomputed = bytesToHex(reverseBytes(sha256d(hexToBytes(best.header))));
  const ok = recomputed === best.hash;
  out.className = 'verify-out ' + (ok ? 'ok' : 'bad');
  out.innerHTML = ok
    ? '✓ recomputed sha256d(header) = ' + recomputed + '<br>difficulty ' + formatDifficulty(best.difficulty) +
      ' — a genuine double-SHA-256 result you can reproduce anywhere.'
    : '✗ mismatch! recomputed ' + recomputed;
}

// --------------------------------------------------------------------------
// Logging + status + persistence + wiring
// --------------------------------------------------------------------------

function log(msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = 'line';
  const t = new Date().toLocaleTimeString([], { hour12: false });
  line.innerHTML = '<span class="t">' + t + '</span> <span class="' + cls + '">' + escapeHtml(msg) + '</span>';
  el.appendChild(line);
  while (el.childNodes.length > 300) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function setStatus(s) {
  const pill = $('status-pill');
  pill.textContent = s;
  pill.className = 'pill ' + s;
}

const SETTINGS_KEYS = ['pool-address', 'pool-host', 'pool-proxy', 'pool-worker', 'pool-pass', 'pool-suggestdiff', 'bench-diff', 'threads'];
function saveSettings() {
  const data = { mode: state.mode };
  for (const k of SETTINGS_KEYS) data[k] = $(k).value;
  try { localStorage.setItem('lotta-mine', JSON.stringify(data)); } catch {}
}
function loadSettings() {
  let data;
  try { data = JSON.parse(localStorage.getItem('lotta-mine') || '{}'); } catch { data = {}; }
  for (const k of SETTINGS_KEYS) if (data[k] != null && $(k)) $(k).value = data[k];
  if (data.mode) switchMode(data.mode);
}

function switchMode(mode) {
  state.mode = mode;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.mode === mode);
  $('panel-benchmark').classList.toggle('hidden', mode !== 'benchmark');
  $('panel-pool').classList.toggle('hidden', mode !== 'pool');
}

function init() {
  // Self-test gate.
  const st = selfTest();
  const badge = $('selftest');
  if (st.pass) {
    badge.className = 'selftest pass';
    badge.textContent = '✓ self-test passed · sha256d verified on this device';
  } else {
    badge.className = 'selftest fail';
    badge.textContent = '✗ self-test FAILED: ' + st.results.filter((r) => !r[1]).map((r) => r[0]).join(', ');
  }
  for (const [name, ok] of st.results) log('self-test · ' + name + ': ' + (ok ? 'PASS' : 'FAIL'), ok ? 'ok' : 'err');

  // Thread slider bounds.
  const cores = navigator.hardwareConcurrency || 4;
  const slider = $('threads');
  slider.max = Math.max(1, cores);
  slider.value = Math.max(1, Math.min(cores, Math.ceil(cores / 2)));
  $('threads-val').textContent = slider.value;

  loadSettings();
  $('threads-val').textContent = $('threads').value;

  // Wiring.
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => { switchMode(t.dataset.mode); saveSettings(); });
  slider.addEventListener('input', () => {
    $('threads-val').textContent = slider.value;
    if (state.running) miner.setWorkerCount(parseInt(slider.value, 10));
  });
  $('toggle').addEventListener('click', () => (state.running ? stop() : start()));
  $('verify-btn').addEventListener('click', runVerify);
  for (const k of SETTINGS_KEYS) $(k).addEventListener('change', saveSettings);

  setInterval(tick, 500);
  log('ready · ' + cores + ' CPU threads detected · choose a mode and press start');
}

init();
