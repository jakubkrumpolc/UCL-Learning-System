"""Small WebSocket connections (RFC 6455) on asyncio streams.

Scribe uses two of them: the browser talks to serve.py over one, and serve.py
talks to xAI's speech-to-text over the other. Writing the protocol here keeps
the site free of third-party packages.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import ssl
import struct
import urllib.parse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
MAX_MESSAGE = 16 * 1024 * 1024


class ConnectionClosed(Exception):
    """The connection ended: closed by either side, or dropped."""


class HandshakeError(Exception):
    """The server answered the opening handshake with a status other than 101."""

    def __init__(self, status: int, body: bytes = b""):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body  # the start of the error page, which often says why


def accept_key(key: str) -> str:
    """The Sec-WebSocket-Accept value that answers a Sec-WebSocket-Key."""
    digest = hashlib.sha1((key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def upgrade_headers(key: str) -> list[tuple[str, str]]:
    """Headers for the 101 response that turns an HTTP request into a socket."""
    return [
        ("Upgrade", "websocket"),
        ("Connection", "Upgrade"),
        ("Sec-WebSocket-Accept", accept_key(key)),
    ]


def apply_mask(data: bytes, mask: bytes) -> bytes:
    """XOR data with the 4-byte mask. Masking and unmasking are the same."""
    n = len(data)
    key = (mask * (n // 4 + 1))[:n]
    value = int.from_bytes(data, "little") ^ int.from_bytes(key, "little")
    return value.to_bytes(n, "little")


class WebSocket:
    """One open connection. Clients mask the frames they send; servers don't."""

    def __init__(self, reader, writer, client: bool):
        self.reader = reader
        self.writer = writer
        self.client = client
        self.closed = False

    async def recv(self) -> str | bytes:
        """Return the next text or binary message, answering pings on the way."""
        kind, message = BINARY, bytearray()
        while True:
            fin, opcode, payload = await self._read_frame()
            if opcode == PING:
                await self._send_frame(PONG, payload)
            elif opcode == CLOSE:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                reason = payload[2:].decode("utf-8", "replace")
                await self.close()
                raise ConnectionClosed(f"closed ({code}{': ' + reason if reason else ''})")
            elif opcode in (TEXT, BINARY, CONTINUATION):
                if opcode != CONTINUATION:
                    kind, message = opcode, bytearray()
                message += payload
                if len(message) > MAX_MESSAGE:
                    await self.close(1009)
                    raise ConnectionClosed("message too big")
                if fin:
                    return message.decode("utf-8") if kind == TEXT else bytes(message)

    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str):
            await self._send_frame(TEXT, message.encode("utf-8"))
        else:
            await self._send_frame(BINARY, message)

    async def send_json(self, data) -> None:
        await self.send(json.dumps(data))

    async def close(self, code: int = 1000) -> None:
        """Send a close frame (once) and close the connection."""
        if self.closed:
            return
        try:
            await self._send_frame(CLOSE, struct.pack("!H", code))
        except ConnectionClosed:
            pass
        self.closed = True
        self.writer.close()

    async def _read_frame(self) -> tuple[bool, int, bytes]:
        try:
            first, second = await self.reader.readexactly(2)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if length > MAX_MESSAGE:
                raise ConnectionClosed("frame too big")
            mask = await self.reader.readexactly(4) if second & 0x80 else None
            payload = await self.reader.readexactly(length)
        except (asyncio.IncompleteReadError, OSError) as exc:
            raise ConnectionClosed("connection dropped") from exc
        if mask:
            payload = apply_mask(payload, mask)
        return bool(first & 0x80), first & 0x0F, payload

    async def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.closed:
            raise ConnectionClosed("already closed")
        n = len(payload)
        mask_bit = 0x80 if self.client else 0
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, mask_bit | n)
        elif n < 1 << 16:
            head = struct.pack("!BBH", 0x80 | opcode, mask_bit | 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, mask_bit | 127, n)
        if self.client:
            mask = os.urandom(4)
            head += mask
            payload = apply_mask(payload, mask)
        try:
            self.writer.write(head + payload)
            await self.writer.drain()
        except OSError as exc:
            raise ConnectionClosed("connection dropped") from exc


async def from_socket(sock) -> WebSocket:
    """Wrap a socket whose upgrade request has already been answered with 101."""
    reader, writer = await asyncio.open_connection(sock=sock)
    return WebSocket(reader, writer, client=False)


async def connect(url: str, headers: dict[str, str], timeout: float = 10) -> WebSocket:
    """Open a client connection to a ws:// or wss:// URL."""
    return await asyncio.wait_for(_connect(url, headers), timeout)


async def _connect(url: str, headers: dict[str, str]) -> WebSocket:
    parts = urllib.parse.urlsplit(url)
    secure = parts.scheme == "wss"
    reader, writer = await asyncio.open_connection(
        parts.hostname,
        parts.port or (443 if secure else 80),
        ssl=ssl.create_default_context() if secure else None,
    )
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    lines = [
        f"GET {target} HTTP/1.1",
        f"Host: {parts.netloc}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ] + [f"{name}: {value}" for name, value in headers.items()]
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))

    try:
        head = await reader.readuntil(b"\r\n\r\n")
        status_line, *header_lines = head.decode("latin-1").split("\r\n")
        status = int(status_line.split()[1])
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, OSError,
            IndexError, ValueError) as exc:
        writer.close()
        raise ConnectionClosed("no valid handshake reply") from exc
    if status != 101:
        try:
            body = await asyncio.wait_for(reader.read(4096), 2)
        except (asyncio.TimeoutError, OSError):
            body = b""
        writer.close()
        raise HandshakeError(status, body)
    reply = {}
    for line in header_lines:
        name, _, value = line.partition(":")
        reply[name.strip().lower()] = value.strip()
    if reply.get("sec-websocket-accept") != accept_key(key):
        writer.close()
        raise ConnectionClosed("handshake reply did not match")
    return WebSocket(reader, writer, client=True)
