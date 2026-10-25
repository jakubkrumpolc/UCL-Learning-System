#!/usr/bin/env python3
"""Serve the study site on this computer and open it in a browser.

The Linux, macOS, and Windows files in this folder call this script.
"""

from __future__ import annotations

import argparse
import http.server
import os
import posixpath
import shlex
import socket
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"
DEFAULT_PORT = 8000
SERVER_HEADER = "X-UCL-Learning-System"


def say(message: str) -> None:
    print(message, flush=True)


def fail(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class StudySiteHandler(http.server.SimpleHTTPRequestHandler):
    """Serve the site files, and refuse hidden paths such as .git."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        if requests_hidden_path(self.path):
            self.send_error(http.HTTPStatus.NOT_FOUND, "File not found")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header(SERVER_HEADER, "1")
        super().end_headers()


class LoopbackServer(http.server.ThreadingHTTPServer):
    entered = False
    # Windows treats SO_REUSEADDR as permission for another process to bind
    # this same port. Leave it off there so a second launch cannot share it.
    allow_reuse_address = os.name != "nt"

    def serve_forever(self, poll_interval=0.5):
        self.entered = True
        super().serve_forever(poll_interval)


def requests_hidden_path(url_path: str) -> bool:
    raw = urllib.parse.unquote(url_path.split("?", 1)[0].split("#", 1)[0])
    parts = [
        part
        for part in posixpath.normpath(raw).split("/")
        if part not in ("", ".")
    ]
    return any(part.startswith(".") or part == ".." for part in parts)


def make_server(host: str, port: int) -> LoopbackServer:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET

    class BoundServer(LoopbackServer):
        address_family = family

    return BoundServer((host, port), StudySiteHandler)


def classify_port(host: str, port: int) -> str:
    """Return 'free', 'site', 'http', or 'busy'."""
    try:
        sock = socket.create_connection((host, port), timeout=0.5)
    except ConnectionRefusedError:
        return "free"
    except OSError:
        return "busy"

    try:
        sock.settimeout(0.5)
        host_header = f"[{host}]" if ":" in host else host
        sock.sendall(
            (
                f"GET / HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n"
            ).encode("ascii")
        )
        data = bytearray()
        while len(data) < 4096:
            chunk = sock.recv(4096 - len(data))
            if not chunk:
                break
            data.extend(chunk)
    except OSError:
        return "busy"
    finally:
        sock.close()

    head = bytes(data).partition(b"\r\n\r\n")[0].lower()
    if not head.startswith(b"http/"):
        return "busy"
    if b"x-ucl-learning-system: 1" in head:
        return "site"
    return "http"


def browser_command(url: str) -> list[str] | None:
    custom = os.environ.get("BROWSER", "").strip()
    if custom:
        return shlex.split(custom) + [url]
    if sys.platform == "darwin":
        return ["open", url]
    if sys.platform.startswith("win"):
        return None
    return ["xdg-open", url]


def open_browser(url: str) -> None:
    """Open url in the desktop browser. The server keeps running either way."""
    command = browser_command(url)
    try:
        if command is None:
            os.startfile(url)  # type: ignore[attr-defined]
            return
        proc = subprocess.Popen(command)
    except Exception as exc:
        fail(f"Could not open a browser ({exc}).")
        say(f"Open this address in your browser: {url}")
        return
    try:
        code = proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        return
    if code != 0:
        say(f"Open this address in your browser: {url}")


def stop_extra(server: LoopbackServer) -> None:
    if server.entered:
        server.shutdown()
    server.server_close()


def serve(port: int) -> int:
    url = f"http://{HOST}:{port}/"

    try:
        primary = make_server(HOST, port)
    except OSError as exc:
        state = classify_port(HOST, port)
        if (state == "site"):
            say(f"Already available at {url}")
            open_browser(url)
            return 0
        if (state in {"http", "busy"}):
            fail(f"Port {port} is already in use on this computer.")
            fail(
                "Stop the other program, or run the startup file again with "
                "another port, for example 8081."
            )
            return 1
        fail(f"Could not listen on {url} ({exc}).")
        return 1

    extras: list[LoopbackServer] = []
    if socket.has_ipv6:
        try:
            extras.append(make_server("::1", port))
        except OSError:
            fail("IPv6 localhost did not start. Use the 127.0.0.1 address.")

    for extra in extras:
        threading.Thread(
            target=extra.serve_forever,
            name="study-site-ipv6",
            daemon=True,
        ).start()

    say(f"UCL Learning System is available at {url}")
    if extras:
        say(f"localhost points here too: http://localhost:{port}/")
    say("Leave this window open while you study. Press Ctrl+C to stop.")
    # The listening socket is already open. Delay the browser slightly so
    # the first request arrives after serve_forever is in its loop.
    opener = threading.Timer(0.2, lambda: open_browser(url))
    opener.daemon = True
    opener.start()

    try:
        primary.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    finally:
        opener.cancel()
        primary.server_close()
        for extra in extras:
            stop_extra(extra)
    return 0


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 7):
        fail("Python 3.7 or newer is required.")
        return 1

    parser = argparse.ArgumentParser(
        description="Serve the UCL Learning System on localhost."
    )
    parser.add_argument(
        "port",
        nargs="?",
        type=int,
        default=DEFAULT_PORT,
        help=f"port to listen on (default: {DEFAULT_PORT})",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        fail("Port must be between 1 and 65535.")
        return 1
    return serve(args.port)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
        sys.exit(0)
