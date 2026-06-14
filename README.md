# lotta-mine ⛏️

A **Bitcoin lottery miner that runs in a phone browser.** Open a page, tap start,
and your phone starts computing real SHA‑256d block-header hashes and (optionally)
submitting them to a real mining pool over Stratum. The work is genuine and
verifiable. The odds of winning are gloriously, cosmically bad — which is the
whole point. It's a conversation piece, not an investment.

> A modern phone does on the order of **10⁶ hashes/second**. The Bitcoin network
> does about **10²⁰**. At that rate, the expected time for a phone to solve a
> block is **longer than the current age of the universe** — per block. You will
> not win. But every hash on the screen is real, and you can prove it.

---

## Why this is interesting (and honest)

Lottery / solo mining means you point a tiny miner at a **solo pool** (e.g.
[solo.ckpool.org](https://solo.ckpool.org)). If *you* are the one whose nonce
solves the block, *you* get the entire block reward (minus a small pool fee).
The chance is microscopic, but nonzero, and people really do run it for fun.

This project makes that runnable by anyone with a browser, and makes the output
**verifiable** rather than asking you to trust a number:

- **On-device self-test.** Before mining, the page recomputes the hashes of the
  Bitcoin **genesis block** and **block 125552** and checks them against their
  known values. If the badge isn't green, don't trust the miner.
- **Verify panel.** The best hash found is re-hashed from its 80-byte header in
  the page, in front of you. Paste the header or hash into any block explorer or
  your own `sha256d` and you'll get the same answer.
- **Real shares.** In pool mode, the pool independently validates your shares.
  An "accepted" share is third-party proof your phone did the work it claims.
- **Reproducible tests.** `npm test` proves the SHA‑256d core, the optimized
  worker path, the Stratum job construction, and the difficulty math against
  vectors independently confirmed with Python's `hashlib`.

---

## Quick start

You need Python 3 (preinstalled on macOS/Linux). No `pip install`, no Node
required to *run* it.

```bash
# from the repo root — serves the app AND bridges Stratum, on one port
python3 proxy/stratum_proxy.py --serve .
```

Open **http://localhost:8080**.

- **Benchmark** tab → press **Start mining**. No network needed; it mines a
  synthetic job so you can watch (and verify) your phone's real hashrate.
- **Mine a Pool** tab → enter your Bitcoin payout address, keep the defaults
  (`solo.ckpool.org:3333`, bridge `ws://localhost:8080`), press start.

### Put it on your phone

Your phone and computer on the same Wi‑Fi:

```bash
python3 proxy/stratum_proxy.py --serve . --host 0.0.0.0
```

Find your computer's LAN IP (e.g. `192.168.1.42`) and browse to
`http://192.168.1.42:8080` on the phone. In the **Mine a Pool** tab set the
bridge URL to `ws://192.168.1.42:8080`.

For a true "anyone, anywhere" setup, host the static files on any web host and
run the proxy on a small always-on box (a VPS or a Raspberry Pi). See
[Deploying](#deploying-for-real).

---

## Why a proxy is required

Browsers **cannot open raw TCP sockets**, and Stratum is line-delimited
JSON-RPC over TCP (often TLS). So `proxy/stratum_proxy.py` accepts a WebSocket
from the browser, reads the target pool from `?pool=host:port`, and pipes bytes
both ways, preserving the newline framing. It's ~250 lines of pure standard
library and also doubles as a static file server so one command runs everything.

```
 phone browser  ──WebSocket──►  stratum_proxy.py  ──TCP──►  solo.ckpool.org:3333
   (JS miner)   ◄────────────   (this repo)       ◄──────   (real Bitcoin pool)
```

---

## How the mining works

A Bitcoin block header is 80 bytes. Mining means: find a nonce such that
`SHA256(SHA256(header))`, read as a little-endian 256-bit number, is **below the
target**. We just iterate the nonce and hash.

- **`src/sha256.js`** — a SHA‑256 compression function plus a `sha256d`
  reference. The bytes are verified at runtime by the self-test.
- **`src/worker.js`** — the hot loop, one per CPU core (Web Workers). It uses the
  **midstate** trick: the first 64 of the 80 header bytes never change while the
  nonce moves, so their SHA‑256 block is absorbed once and only the final blocks
  are recomputed per nonce (~1.5× fewer compressions). It tracks the best
  (lowest) hash cheaply on 64 bits and only does a full 256-bit compare on the
  rare candidate that could be a share.
- **`src/miner.js`** — splits the 2³² nonce space across cores, aggregates the
  hashrate, and re-hashes every "best" candidate through the full reference
  hasher so the headline number is always independently checkable.
- **`src/stratum.js`** — the Stratum client: subscribe → authorize → receive
  jobs → build the header → submit shares.

### The fiddly part: Stratum byte order

Reconstructing the header from a `mining.notify` is where almost every miner
bug lives, so it's documented and tested. Given the notify fields:

| field | from pool | goes into header as |
|-------|-----------|---------------------|
| `version` | big-endian hex | reversed to little-endian |
| `prevhash` | 32 bytes, 4-byte-word order | each 4-byte word byte-swapped |
| merkle root | computed below | **internal order, not reversed** |
| `ntime` | big-endian hex | reversed to little-endian |
| `nbits` | big-endian hex | reversed to little-endian |
| nonce | (you choose) | little-endian |

The merkle root is built from the coinbase:

```
coinbase   = coinb1 + extranonce1 + extranonce2 + coinb2      (concatenate bytes)
root       = sha256d(coinbase)
for branch in merkle_branch:  root = sha256d(root + branch)
```

This pipeline is checked two ways: against a fixed vector in `npm test`, and —
during development — against **live** `solo.ckpool.org` jobs, reproduced
byte-for-byte by an independent Python implementation.

---

## Verifying it yourself

```bash
npm test          # Node; mirrors the in-browser self-test
```

```
sha256d reference vs known block hashes
  ok  genesis block 0
  ok  block 125552
worker midstate path == reference hasher
  ok  genesis
  ok  block 125552
  ok  1000 random headers
stratum job construction (real StratumClient code)
  ok  coinbase + merkle root
  ok  prevhash word-swap
difficulty / target math ...
end-to-end mining loop finds a real sub-target hash
  ok  found nonce below share target  nonce=1085914 hash=0000073e55b8...
ALL PASS
```

The genesis self-test value, for reference — `sha256d` of the genesis header,
displayed big-endian, is:

```
000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f
```

which is exactly [block 0 on any explorer](https://mempool.space/block/000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f).

---

## The odds, exactly

Expected hashes to solve a block ≈ `network_difficulty × 2³²`. At a measured
hashrate `H`, expected time is `network_difficulty × 2³² / H`. The app shows this
live (and, when it gets silly, in multiples of the age of the universe). For a
phone at ~1 MH/s against difficulty ≈ 1.2×10¹⁴, that's ~1.6×10¹⁰ years per
block — a bit longer than the universe has existed so far. Mine to understand,
not to earn.

---

## Deploying for real

- **Static app**: any static host (GitHub Pages, Netlify, S3, …). It's just
  `index.html`, `css/`, and `src/`.
- **Proxy**: run `stratum_proxy.py` on an always-on machine with a public
  address. If you expose it, it becomes an open TCP relay to whatever pool a
  client names — restrict it:

  ```bash
  python3 proxy/stratum_proxy.py --host 0.0.0.0 --port 8080 \
      --allow solo.ckpool.org:3333
  ```

  Put it behind TLS (a reverse proxy) and use `wss://` from an HTTPS page.

---

## FAQ

**Is this safe? Does it touch my wallet?** It never sees your private keys. Your
Bitcoin address is only a *payout destination* sent to the pool you choose. No
telemetry.

**Will it drain my battery / heat my phone?** Yes, while running — it's using the
CPU. Use the intensity slider; stop when you're done.

**WebAssembly?** The core is carefully optimized JavaScript running in Web
Workers (portable, zero build step, and proven correct here). The worker is
structured so a WASM SHA‑256 backend can be dropped in for more hashrate without
touching the rest; it would raise the number on the screen but not your odds.

**Why JavaScript and not a "real" miner?** Because the goal is *anyone, on a
phone, in a browser, in ten seconds* — and to make every number on screen
something you can check. It is not meant to compete with ASICs (nothing can).

---

## Project layout

```
index.html              mobile-first UI shell
css/style.css           styles
src/util.js             hex/endian + difficulty/target math
src/sha256.js           SHA-256 compression, sha256d, midstate
src/worker.js           per-core mining hot loop (Web Worker)
src/miner.js            worker-pool manager + hashrate + best-share
src/stratum.js          Stratum-over-WebSocket client + header construction
src/app.js              UI controller, self-test, benchmark/pool modes, verify
proxy/stratum_proxy.py  WebSocket↔TCP Stratum bridge + static server (stdlib)
test/core.test.mjs      Node correctness tests (run with `npm test`)
```

## License

MIT. Mine responsibly; mostly, mine curiously.
