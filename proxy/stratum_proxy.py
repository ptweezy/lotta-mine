#!/usr/bin/env python3
"""
stratum_proxy.py — a WebSocket <-> TCP bridge for Stratum, plus an optional
static file server. Pure Python 3 standard library: no pip install required.

Why this exists
---------------
Browsers cannot open raw TCP sockets, but Stratum (the pool mining protocol) is
line-delimited JSON-RPC over TCP. This proxy accepts a WebSocket connection from
the browser, reads the desired pool from the `?pool=host:port` query string, and
pipes bytes both ways. Each side speaks newline-delimited JSON; we preserve that
framing exactly.

Usage
-----
    python3 proxy/stratum_proxy.py                 # proxy only, ws://127.0.0.1:8080
    python3 proxy/stratum_proxy.py --serve .       # also serve the app over http
    python3 proxy/stratum_proxy.py --host 0.0.0.0 --port 8080 --serve .

Then open http://localhost:8080 and point the app's bridge URL at
ws://localhost:8080 (the default).

Security note
-------------
Bound to 127.0.0.1 by default. If you expose it (`--host 0.0.0.0`) it becomes an
open TCP relay to whatever `host:port` a client names — restrict upstreams with
`--allow host:port,host2:port2` in that case.
"""

import argparse
import asyncio
import base64
import hashlib
import mimetypes
import os
import struct
import sys
import urllib.parse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

ALLOW = None          # set of "host:port" strings, or None to allow all
SERVE_ROOT = None     # absolute path to static root, or None to disable


# --------------------------------------------------------------------------
# Minimal WebSocket framing (RFC 6455), enough for text + ping/pong + close.
# --------------------------------------------------------------------------

def ws_accept_key(key: str) -> str:
    digest = hashlib.sha1((key + WS_GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def encode_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    # Server-to-client frames are never masked.
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload


async def read_frame(reader: asyncio.StreamReader):
    """Return (opcode, data) for one complete message, or None on close/EOF."""
    data = bytearray()
    first_opcode = None
    while True:
        hdr = await reader.readexactly(2)
        b0, b1 = hdr[0], hdr[1]
        opcode = b0 & 0x0F
        fin = b0 & 0x80
        masked = b1 & 0x80
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", await reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", await reader.readexactly(8))[0]
        mask = await reader.readexactly(4) if masked else b"\x00\x00\x00\x00"
        payload = bytearray(await reader.readexactly(length))
        if masked:
            for i in range(length):
                payload[i] ^= mask[i & 3]

        if opcode == 0x8:                 # close
            return (0x8, bytes(payload))
        if opcode == 0x9:                 # ping -> caller will pong
            return (0x9, bytes(payload))
        if opcode == 0xA:                 # pong
            continue
        if opcode != 0x0:                 # new (non-continuation) data frame
            first_opcode = opcode
        data += payload
        if fin:
            return (first_opcode if first_opcode is not None else 0x1, bytes(data))


# --------------------------------------------------------------------------
# Bridge: WebSocket client <-> Stratum TCP pool
# --------------------------------------------------------------------------

async def bridge(ws_reader, ws_writer, target: str):
    if ALLOW is not None and target not in ALLOW:
        await send_pool_message(ws_writer, "proxy: upstream %r not in allow-list" % target)
        return
    try:
        host, port = target.rsplit(":", 1)
        pool_reader, pool_writer = await asyncio.wait_for(
            asyncio.open_connection(host, int(port)), timeout=15)
    except Exception as e:                                   # noqa: BLE001
        await send_pool_message(ws_writer, "proxy: cannot reach pool %s (%s)" % (target, e))
        return

    log("bridged client -> %s" % target)

    async def ws_to_pool():
        try:
            while True:
                frame = await read_frame(ws_reader)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    ws_writer.write(encode_frame(payload, 0xA))   # pong
                    await ws_writer.drain()
                    continue
                # Browser already newline-terminates each JSON message.
                pool_writer.write(payload if payload.endswith(b"\n") else payload + b"\n")
                await pool_writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass

    async def pool_to_ws():
        try:
            while True:
                line = await pool_reader.readline()           # Stratum is line-delimited
                if not line:
                    break
                ws_writer.write(encode_frame(line))           # keep the trailing \n
                await ws_writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass

    t1 = asyncio.create_task(ws_to_pool())
    t2 = asyncio.create_task(pool_to_ws())
    done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    pool_writer.close()
    log("closed bridge to %s" % target)


async def send_pool_message(ws_writer, text: str):
    """Send a Stratum client.show_message so the app surfaces proxy errors."""
    log(text)
    msg = '{"id":null,"method":"client.show_message","params":[%s]}\n' % _json_str(text)
    ws_writer.write(encode_frame(msg.encode()))
    await ws_writer.drain()


def _json_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


# --------------------------------------------------------------------------
# Connection handler: WebSocket upgrade, or static file serving.
# --------------------------------------------------------------------------

async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        request = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=20)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
        writer.close()
        return

    lines = request.decode("latin1").split("\r\n")
    try:
        method, raw_path, _ = lines[0].split(" ", 2)
    except ValueError:
        writer.close()
        return
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    parsed = urllib.parse.urlparse(raw_path)
    query = urllib.parse.parse_qs(parsed.query)

    if headers.get("upgrade", "").lower() == "websocket":
        key = headers.get("sec-websocket-key", "")
        accept = ws_accept_key(key)
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
        )
        writer.write(resp.encode())
        await writer.drain()
        target = query.get("pool", [""])[0]
        if not target:
            await send_pool_message(writer, "proxy: no ?pool=host:port given")
        else:
            await bridge(reader, writer, target)
        try:
            writer.close()
        except Exception:                                    # noqa: BLE001
            pass
        return

    # Not a WebSocket upgrade -> static file server (if enabled).
    if SERVE_ROOT and method == "GET":
        await serve_static(writer, parsed.path)
    else:
        writer.write(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
    writer.close()


async def serve_static(writer: asyncio.StreamWriter, url_path: str):
    rel = urllib.parse.unquote(url_path).lstrip("/")
    if rel == "" or rel.endswith("/"):
        rel += "index.html"
    full = os.path.realpath(os.path.join(SERVE_ROOT, rel))
    if not full.startswith(SERVE_ROOT + os.sep) and full != SERVE_ROOT:
        return _http(writer, 403, b"forbidden")
    if not os.path.isfile(full):
        return _http(writer, 404, b"not found")
    ctype, _ = mimetypes.guess_type(full)
    if full.endswith((".js", ".mjs")):
        ctype = "text/javascript"                            # required for ES modules
    ctype = ctype or "application/octet-stream"
    with open(full, "rb") as f:
        body = f.read()
    head = (
        "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
        "Cache-Control: no-cache\r\n\r\n" % (ctype, len(body))
    )
    writer.write(head.encode() + body)
    await writer.drain()


def _http(writer, code, body):
    msg = {403: "Forbidden", 404: "Not Found"}.get(code, "Error")
    writer.write(("HTTP/1.1 %d %s\r\nContent-Length: %d\r\n\r\n" % (code, msg, len(body))).encode() + body)


def log(msg: str):
    print("[proxy] " + msg, flush=True)


async def main():
    global ALLOW, SERVE_ROOT
    ap = argparse.ArgumentParser(description="Stratum WebSocket bridge + static server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--serve", metavar="DIR", help="also serve static files from DIR")
    ap.add_argument("--allow", help="comma-separated allow-list of host:port upstreams")
    args = ap.parse_args()

    if args.allow:
        ALLOW = set(x.strip() for x in args.allow.split(",") if x.strip())
    if args.serve:
        SERVE_ROOT = os.path.realpath(args.serve)

    server = await asyncio.start_server(handle, args.host, args.port)
    log("listening on %s:%d  (ws bridge%s)" % (
        args.host, args.port, "  +  http://%s:%d" % (args.host, args.port) if SERVE_ROOT else ""))
    if SERVE_ROOT:
        log("serving %s" % SERVE_ROOT)
    if ALLOW:
        log("upstream allow-list: %s" % ", ".join(sorted(ALLOW)))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
