"""Scribe: live transcription for the study portal, and the portal's xAI settings.

serve.py passes every /api/ request and the /ws/transcribe socket here. Mic
audio from the browser is relayed to xAI's streaming speech-to-text, and each
finished line is saved in SQLite. The xAI key stays in .env on this computer.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
import re
import ssl
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import scribe_files
import websocket
from scribe_db import Store
from websocket import ConnectionClosed, HandshakeError, WebSocket

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
SOCKET_PATH = "/ws/transcribe"
MAX_BODY = 64 * 1024
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_amount(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


load_dotenv(ENV_PATH)

API_KEY = os.environ.get("XAI_API_KEY", "")
XAI_STT_URL = os.environ.get("XAI_STT_URL", "wss://api.x.ai/v1/stt")
XAI_MODEL = os.environ.get("XAI_STT_MODEL", "")  # empty = let xAI pick its current default
XAI_MODELS_URL = os.environ.get("XAI_MODELS_URL", "https://api.x.ai/v1/models")
# Speech-to-text models to try, besides any transcription models xAI's model
# list reports. grok-voice-transcribe-2.0 is the documented default; the others
# are older names. Only the ones the key can open a stream with are offered.
CANDIDATE_MODELS = ["grok-voice-transcribe-2.0", "grok-voice-transcribe-1.0", "grok-stt"]
MODELS_TTL = 600  # seconds to remember which models a key can use
# Used to estimate spend locally. xAI's published streaming STT price at launch was $0.20/hour.
PRICE_PER_HOUR = env_amount("XAI_STT_PRICE_PER_HOUR", 0.20)
MONTHLY_BUDGET = env_amount("MONTHLY_BUDGET_USD", 0)  # 0 = no budget
# Hidden, so serve.py never hands the database out as a file.
DB_PATH = ROOT / os.environ.get("DB_PATH", ".scribe/transcripts.db")
DEBUG_EVENTS = os.environ.get("DEBUG_EVENTS") == "1"
# Saving each recording to a folder: where, what, and in which formats.
SAVE_DIR = os.environ.get("SCRIBE_SAVE_DIR", "")  # empty = Documents/Scribe
SAVE_TRANSCRIPT = os.environ.get("SCRIBE_SAVE_TRANSCRIPT", "1") != "0"
SAVE_AUDIO = os.environ.get("SCRIBE_SAVE_AUDIO", "1") != "0"
TRANSCRIPT_FORMAT = "txt" if os.environ.get("SCRIBE_TRANSCRIPT_FORMAT") == "txt" else "md"
AUDIO_FORMAT = "wav" if os.environ.get("SCRIBE_AUDIO_FORMAT") == "wav" else "compressed"
SUPPORTED_RATES = {8000, 16000, 22050, 24000, 44100, 48000}

_store = None
_store_lock = threading.Lock()
_models_cache: dict[str, tuple[float, dict]] = {}  # API key -> (time checked, answer)


def save_folder() -> Path:
    return Path(SAVE_DIR).expanduser() if SAVE_DIR else scribe_files.default_folder()


def store() -> Store:
    """Open the database on first use, so it only exists once Scribe is used."""
    global _store
    with _store_lock:
        if _store is None:
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            _store = Store(str(DB_PATH))
        return _store


# ---------- Requests and responses ----------

Request = collections.namedtuple("Request", "id query body")
Response = collections.namedtuple("Response", "status headers body upgrade", defaults=(None,))


def body_response(status: int, body: bytes, content_type: str, extra=()) -> Response:
    headers = [
        ("Content-Type", content_type),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
    ]
    return Response(status, headers + list(extra), body)


def json_response(data, status: int = 200) -> Response:
    return body_response(status, json.dumps(data).encode("utf-8"), "application/json")


def local_request(headers) -> bool:
    """Only answer the site as served on this computer.

    The Origin check stops other websites open in the browser from driving
    this server (and spending the key); the Host check stops DNS rebinding.
    """
    host = headers.get("Host", "")
    origin = headers.get("Origin")
    try:
        if urllib.parse.urlsplit("//" + host).hostname not in LOCAL_HOSTS:
            return False
        return origin is None or urllib.parse.urlsplit(origin).netloc == host
    except ValueError:
        return False


# ---------- REST API ----------

def list_sessions(request):
    return json_response(store().list_sessions(request.query.get("q", "").strip()))


def get_session(request):
    session = store().get_session(request.id)
    if not session:
        return json_response({"error": "not found"}, 404)
    return json_response({**session, "segments": store().get_segments(request.id)})


def update_session(request):
    title = str(request.body.get("title", "")).strip()
    if not title:
        return json_response({"error": "title required"}, 400)
    store().rename_session(request.id, title[:200])
    session = store().get_session(request.id)
    if session and session["ended_at"]:
        sync_files(session)
    return json_response({"ok": True})


def delete_session(request):
    store().delete_session(request.id)
    return Response(204, [], b"")


def fmt_ts(ms: int) -> str:
    s = ms // 1000
    h, m, s = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02}:{s:02}" if h else f"{m:02}:{s:02}"


def transcript_text(session: dict, segments: list[dict], fmt: str) -> str:
    """The transcript as Markdown ("md") or plain text, for exports and saved files."""
    started = datetime.fromisoformat(session["started_at"]).astimezone().strftime("%d %b %Y, %H:%M")
    lines = [f"# {session['title']}", "", f"_Started {started}_", ""] if fmt == "md" else []
    for seg in segments:
        who = f" {seg['speaker']}:" if seg["speaker"] else ""
        stamp = f"**[{fmt_ts(seg['start_ms'])}]**" if fmt == "md" else f"[{fmt_ts(seg['start_ms'])}]"
        lines.append(f"{stamp}{who} {seg['text']}")
        if fmt == "md":
            lines.append("")
    return "\n".join(lines) + "\n"


def export_session(request):
    session = store().get_session(request.id)
    if not session:
        return body_response(404, b"not found", "text/plain; charset=utf-8")
    fmt = "md" if request.query.get("format") == "md" else "txt"
    filename = f"transcript-{request.id}.{fmt}"
    return body_response(
        200,
        transcript_text(session, store().get_segments(request.id), fmt).encode("utf-8"),
        "text/plain; charset=utf-8",
        [("Content-Disposition", f'attachment; filename="{filename}"')],
    )


def sync_files(session: dict) -> None:
    """After a rename: give the saved files the new title, and rewrite the transcript's heading."""
    paths = scribe_files.rename_files(session)
    store().set_files(session["id"], paths["transcript"], paths["audio"])
    transcript = paths["transcript"]
    if transcript and Path(transcript).exists():
        fmt = "md" if transcript.endswith(".md") else "txt"
        try:
            scribe_files.write_text(Path(transcript), transcript_text(session, store().get_segments(session["id"]), fmt))
        except OSError:
            pass


def reveal_session(request):
    session = store().get_session(request.id)
    session = session or {}
    saved = [Path(p) for p in (session.get("transcript_path"), session.get("audio_path")) if p]
    existing = [p for p in saved if p.exists()]
    if not existing:
        return json_response({"error": "The saved files have been moved or deleted."}, 404)
    scribe_files.reveal(existing[0])
    return Response(204, [], b"")


def choose_folder(request):
    """Open the system's folder picker on this computer and return the folder chosen."""
    initial = str(request.body.get("initial") or "").strip() or str(save_folder())
    chosen, problem = scribe_files.choose_folder(initial)
    if problem:
        return json_response({"error": problem}, 500)
    return json_response({"path": chosen})


# ---------- Settings ----------

KEY_RE = re.compile(r"^[A-Za-z0-9_\-.]{10,200}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9_\-.:]{0,64}$")


def set_env_values(values: dict[str, str]) -> None:
    """Update keys in .env, keeping everything else. An empty value removes the key."""
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    lines = [l for l in lines if l.partition("=")[0].strip() not in values]
    lines = [f"{k}={v}" for k, v in values.items() if v] + lines
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def settings_payload() -> dict:
    return {
        "has_key": bool(API_KEY),
        "key_hint": f"…{API_KEY[-4:]}" if API_KEY else "",
        "model": XAI_MODEL,
        "known_models": known_models(API_KEY),
        "price_per_hour": PRICE_PER_HOUR,
        "monthly_budget": MONTHLY_BUDGET,
        "save_dir": str(save_folder()),
        "save_transcript": SAVE_TRANSCRIPT,
        "save_audio": SAVE_AUDIO,
        "transcript_format": TRANSCRIPT_FORMAT,
        "audio_format": AUDIO_FORMAT,
    }


def parse_amount(value, limit: float) -> float | None:
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return amount if 0 <= amount <= limit else None


def read_settings_body(body: dict) -> tuple[dict | None, Response | None]:
    key = str(body.get("api_key") or "").strip()
    model = str(body.get("model") or "").strip()
    if key and not KEY_RE.match(key):
        return None, json_response({"error": "That doesn't look like a valid API key."}, 400)
    if not MODEL_RE.match(model):
        return None, json_response({"error": "Model names can only use letters, numbers, - _ . :"}, 400)
    parsed = {"api_key": key, "model": model, "has_model": "model" in body}
    for field, limit, label in (("price_per_hour", 100, "Price per hour"), ("monthly_budget", 1_000_000, "Monthly budget")):
        if field in body:
            parsed[field] = parse_amount(body[field] or 0, limit)
            if parsed[field] is None:
                return None, json_response({"error": f"{label} must be a number between 0 and {limit:,}."}, 400)
    if "save_dir" in body:
        folder = str(body["save_dir"] or "").strip()
        if folder:
            if len(folder) > 1000 or not Path(folder).expanduser().is_absolute():
                return None, json_response({"error": "Give the folder's full path, for example C:\\Users\\you\\Documents\\Scribe."}, 400)
            problem = scribe_files.check_folder(Path(folder).expanduser())
            if problem:
                return None, json_response({"error": problem}, 400)
        parsed["save_dir"] = folder
    for field in ("save_transcript", "save_audio"):
        if field in body:
            parsed[field] = bool(body[field])
    if "transcript_format" in body:
        parsed["transcript_format"] = "txt" if body["transcript_format"] == "txt" else "md"
    if "audio_format" in body:
        parsed["audio_format"] = "wav" if body["audio_format"] == "wav" else "compressed"
    return parsed, None


def get_settings(request):
    return json_response(settings_payload())


def update_settings(request):
    global API_KEY, XAI_MODEL, PRICE_PER_HOUR, MONTHLY_BUDGET
    global SAVE_DIR, SAVE_TRANSCRIPT, SAVE_AUDIO, TRANSCRIPT_FORMAT, AUDIO_FORMAT
    body, error = read_settings_body(request.body)
    if error:
        return error
    changes = {}
    if body["api_key"]:
        API_KEY = changes["XAI_API_KEY"] = body["api_key"]
    if body["has_model"]:
        XAI_MODEL = changes["XAI_STT_MODEL"] = body["model"]
    if "price_per_hour" in body:
        PRICE_PER_HOUR = body["price_per_hour"]
        changes["XAI_STT_PRICE_PER_HOUR"] = f"{PRICE_PER_HOUR:g}"
    if "monthly_budget" in body:
        MONTHLY_BUDGET = body["monthly_budget"]
        changes["MONTHLY_BUDGET_USD"] = f"{MONTHLY_BUDGET:g}" if MONTHLY_BUDGET else ""
    if "save_dir" in body:
        SAVE_DIR = changes["SCRIBE_SAVE_DIR"] = body["save_dir"]
    if "save_transcript" in body:
        SAVE_TRANSCRIPT = body["save_transcript"]
        changes["SCRIBE_SAVE_TRANSCRIPT"] = "1" if SAVE_TRANSCRIPT else "0"
    if "save_audio" in body:
        SAVE_AUDIO = body["save_audio"]
        changes["SCRIBE_SAVE_AUDIO"] = "1" if SAVE_AUDIO else "0"
    if "transcript_format" in body:
        TRANSCRIPT_FORMAT = changes["SCRIBE_TRANSCRIPT_FORMAT"] = body["transcript_format"]
    if "audio_format" in body:
        AUDIO_FORMAT = changes["SCRIBE_AUDIO_FORMAT"] = body["audio_format"]
    if changes:
        set_env_values(changes)
    return json_response(settings_payload())


def get_usage(request):
    return json_response({**store().usage(), "price_per_hour": PRICE_PER_HOUR, "monthly_budget": MONTHLY_BUDGET})


def test_settings(request):
    """Open (and immediately close) an xAI stream to check the key and model. Sends no audio, so it's free."""
    body, error = read_settings_body(request.body)
    if error:
        return error
    key = body["api_key"] or API_KEY
    if not key:
        return json_response({"ok": False, "message": "Enter an API key first."})
    model = body["model"] if body["has_model"] else XAI_MODEL
    try:
        asyncio.run(check_upstream(key, model))
    except Exception as e:
        return json_response({"ok": False, "message": upstream_error(e)})
    return json_response({"ok": True, "message": "Connected to xAI - the key and model work."})


async def check_upstream(key: str, model: str) -> None:
    upstream = await open_upstream({"sample_rate": 16000, "language": "", "diarize": False}, key, model)
    await upstream.close()


# ---------- Models ----------

def known_models(key: str) -> list[str]:
    """The models last confirmed for this key, or the documented default."""
    cached = _models_cache.get(key)
    return cached[1]["models"] if cached and cached[1]["checked"] else CANDIDATE_MODELS[:1]


def listed_models(key: str) -> list[str]:
    """Transcription models in xAI's model list for this key. Often none: the list mostly holds chat models."""
    request = urllib.request.Request(
        XAI_MODELS_URL,
        headers={"Authorization": f"Bearer {key}", "User-Agent": "UCL-CS-Learning-System"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.load(response)
    except (OSError, ValueError):
        return []
    entries = data.get("data") if isinstance(data, dict) else None
    ids = [entry.get("id") for entry in entries or [] if isinstance(entry, dict)]
    return [i for i in ids if isinstance(i, str) and re.search(r"transcri|stt", i)]


async def probe_models(key: str, models: list[str]) -> list:
    return await asyncio.gather(*(check_upstream(key, m) for m in models), return_exceptions=True)


def list_models(request):
    """Every speech-to-text model this key can use, checked by opening (and closing) a stream with each. No audio is sent."""
    key = str(request.body.get("api_key") or "").strip() or API_KEY
    if not key:
        return json_response({
            "models": CANDIDATE_MODELS[:1],
            "checked": False,
            "message": "Add your API key to see every model it can use.",
        })
    if not KEY_RE.match(key):
        return json_response({"error": "That doesn't look like a valid API key."}, 400)
    cached = _models_cache.get(key)
    if cached and time.monotonic() - cached[0] < MODELS_TTL and not request.body.get("refresh"):
        return json_response(cached[1])

    candidates = list(dict.fromkeys(listed_models(key) + CANDIDATE_MODELS))
    results = asyncio.run(probe_models(key, candidates))
    models = [model for model, result in zip(candidates, results) if result is None]
    if models:
        count = f"{len(models)} model{'' if len(models) == 1 else 's'}"
        payload = {"models": models, "checked": True, "message": f"{count} available to your key."}
        _models_cache[key] = (time.monotonic(), payload)
    else:
        error = next(r for r in results if isinstance(r, BaseException))
        payload = {
            "models": CANDIDATE_MODELS[:1],
            "checked": False,
            "message": f"Couldn't check the models. {upstream_error(error)}",
        }
    return json_response(payload)


# ---------- Live transcription relay ----------

def event_text(ev: dict) -> str:
    text = ev.get("text")
    if isinstance(text, str):
        return text.strip()
    return " ".join(w.get("text", "") for w in ev.get("words") or []).strip()


def split_by_speaker(words: list[dict]) -> list[tuple[str | None, list[dict]]]:
    """Group consecutive words that share a speaker."""
    runs: list[tuple[str | None, list[dict]]] = []
    for w in words:
        speaker = w.get("speaker")
        speaker = None if speaker is None else f"Speaker {int(speaker) + 1}" if isinstance(speaker, int) else str(speaker)
        if runs and runs[-1][0] == speaker:
            runs[-1][1].append(w)
        else:
            runs.append((speaker, [w]))
    return runs


class Relay:
    """Turns xAI transcript events into stored segments and simple UI messages for one session."""

    def __init__(self, ws: WebSocket, session_id: int, diarize: bool, on_lines=None):
        self.ws = ws
        self.on_lines = on_lines  # awaited after each finished utterance
        self.session_id = session_id
        self.diarize = diarize
        self.t0 = time.monotonic()
        self.chunks: list[str] = []  # chunk-final text within the current utterance
        self.utterance_start_ms: int | None = None
        self.reported_duration: float | None = None  # audio seconds xAI says it processed

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)

    async def handle(self, ev: dict) -> None:
        kind = ev.get("type")
        if kind == "transcript.partial":
            await self.on_partial(ev)
        elif kind == "transcript.done":
            if isinstance(ev.get("duration"), (int, float)):
                self.reported_duration = float(ev["duration"])
        elif kind == "error":
            message = ev.get("message") or ev.get("error") or json.dumps(ev)
            await self.ws.send_json({"type": "error", "message": f"xAI: {message}"})

    async def on_partial(self, ev: dict) -> None:
        text = event_text(ev)
        if self.utterance_start_ms is None and text:
            self.utterance_start_ms = self.elapsed_ms()

        if ev.get("speech_final"):
            await self.finalize_utterance(ev, text)
        elif ev.get("is_final"):
            if text:
                self.chunks.append(text)
            await self.ws.send_json({"type": "partial", "text": " ".join(self.chunks)})
        else:
            await self.ws.send_json({"type": "partial", "text": " ".join(self.chunks + [text]).strip()})

    async def finalize_utterance(self, ev: dict, text: str) -> None:
        # speech_final restates the whole utterance; fall back to the chunks if it came back empty.
        text = text or " ".join(self.chunks)
        words = [w for w in ev.get("words") or [] if w.get("text")]
        fallback_start = self.utterance_start_ms if self.utterance_start_ms is not None else self.elapsed_ms()
        self.chunks, self.utterance_start_ms = [], None
        if not text:
            await self.ws.send_json({"type": "partial", "text": ""})
            return

        runs = split_by_speaker(words) if self.diarize and words else [(None, words)]
        for speaker, run in runs:
            if run and "start" in run[0] and "end" in run[-1]:
                start_ms, end_ms = int(run[0]["start"] * 1000), int(run[-1]["end"] * 1000)
            elif len(runs) == 1 and all(isinstance(ev.get(k), (int, float)) for k in ("start", "duration")):
                start_ms, end_ms = int(ev["start"] * 1000), int((ev["start"] + ev["duration"]) * 1000)
            else:
                start_ms, end_ms = fallback_start, self.elapsed_ms()
            run_text = " ".join(w["text"] for w in run).strip() if len(runs) > 1 else text
            segment = store().add_segment(self.session_id, start_ms, end_ms, speaker, run_text)
            await self.ws.send_json({"type": "final", "segment": segment})
        await self.ws.send_json({"type": "partial", "text": ""})
        if self.on_lines:
            await self.on_lines()


def handshake_detail(e: HandshakeError) -> str:
    """xAI's own reason for refusing the connection, if it sent one."""
    text = e.body.decode("utf-8", "replace")
    try:
        data = json.loads(text[text.index("{"):text.rindex("}") + 1])
    except ValueError:
        return ""
    return str(data.get("error") or data.get("message") or "") if isinstance(data, dict) else ""


def upstream_error(e: Exception) -> str:
    if isinstance(e, HandshakeError):
        code, detail = e.status, handshake_detail(e)
        # xAI answers a wrong key with 400 "Incorrect API key provided", not 401.
        if code in (401, 403) or "API key" in detail:
            return f"xAI rejected the API key (HTTP {code}). Check it in Settings."
        if detail:
            return f"xAI rejected the request (HTTP {code}): {detail}"
        if code in (400, 404, 422):
            return f"xAI rejected the request (HTTP {code}). Check the model name in Settings."
        return f"xAI rejected the connection (HTTP {code})."
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return "Timed out connecting to xAI. Check your internet connection."
    if isinstance(e, ssl.SSLCertVerificationError):
        return ("Python couldn't check xAI's security certificate. On macOS, run "
                "Install Certificates.command from your Python folder, then try again.")
    return f"Could not connect to xAI: {e}"


async def open_upstream(config: dict, api_key: str, model: str) -> WebSocket:
    params = {
        "encoding": "pcm",
        "sample_rate": config["sample_rate"],
        "interim_results": "true",
        "diarize": "true" if config["diarize"] else "false",
    }
    if model:
        params["model"] = model
    if config["language"]:
        params["language"] = config["language"]
        params["format"] = "true"
    upstream = await websocket.connect(
        f"{XAI_STT_URL}?{urllib.parse.urlencode(params)}",
        {"Authorization": f"Bearer {api_key}"},
        timeout=10,
    )
    try:
        first = json.loads(await asyncio.wait_for(upstream.recv(), timeout=10))
    except Exception:
        await upstream.close()
        raise
    if first.get("type") != "transcript.created":
        await upstream.close()
        raise RuntimeError(first.get("message") or f"unexpected first event: {first}")
    return upstream


async def transcribe(ws: WebSocket) -> None:
    try:
        start = json.loads(await ws.recv())
        config = {
            "sample_rate": int(start.get("sample_rate", 16000)),
            "language": (start.get("language") or "").strip().lower()[:5],
            "diarize": bool(start.get("diarize")),
            "save": bool(start.get("save")),
            "audio_type": str(start.get("audio_type") or "")[:80],
        }
    except (ConnectionClosed, ValueError, TypeError, AttributeError):
        return await ws.close(1002)

    async def fail(message: str):
        try:
            await ws.send_json({"type": "error", "message": message})
        except ConnectionClosed:
            pass
        await ws.close()

    if not API_KEY:
        return await fail("No xAI API key yet. Add one in Settings.")
    if config["sample_rate"] not in SUPPORTED_RATES:
        return await fail(f"Unsupported sample rate {config['sample_rate']} Hz.")

    # "Save to folder" is checked before anything starts, so a bad folder costs nothing.
    saver = None
    if config["save"] and (SAVE_TRANSCRIPT or SAVE_AUDIO):
        folder = save_folder()
        problem = scribe_files.check_folder(folder)
        if problem:
            return await fail(f"{problem}. Choose another folder in Settings, or turn off Save to folder.")
        audio_suffix = None
        if SAVE_AUDIO:
            # Compressed audio comes from the browser; without a recorder there, fall back to WAV.
            recorder = scribe_files.recorder_suffix(config["audio_type"]) if AUDIO_FORMAT == "compressed" else None
            audio_suffix = recorder or ".wav"
        saver = scribe_files.Saver(folder, TRANSCRIPT_FORMAT if SAVE_TRANSCRIPT else None, audio_suffix)

    try:
        upstream = await open_upstream(config, API_KEY, XAI_MODEL)
    except Exception as e:
        return await fail(upstream_error(e))

    session = store().create_session(config["language"] or None, XAI_MODEL or None)

    async def report_save_problem() -> None:
        problem = saver.unreported_problem() if saver else None
        if problem:
            await ws.send_json({"type": "save-error", "message": problem})

    async def save_transcript() -> None:
        if saver:
            current = store().get_session(session["id"])
            saver.write_transcript(transcript_text(current, store().get_segments(session["id"]), saver.transcript_format or "md"))
            await report_save_problem()

    def finish_saving() -> dict | None:
        """Close the files, give them the recording's final title, and say where they are. Runs once."""
        if not saver or saver.finished:
            return None
        saver.finished = True
        saver.close()
        current = store().get_session(session["id"])
        if saver.transcript_path:
            saver.write_transcript(transcript_text(current, store().get_segments(session["id"]), saver.transcript_format))
        paths = scribe_files.rename_files(current)
        store().set_files(session["id"], paths["transcript"], paths["audio"])
        files = [Path(p).name for p in (paths["transcript"], paths["audio"]) if p]
        return {"folder": str(saver.folder), "files": files, "problem": saver.problem}

    if saver:
        saver.start(session, config["sample_rate"])
        store().set_files(session["id"], saver.paths()["transcript"], saver.paths()["audio"])
        session = store().get_session(session["id"])
        await save_transcript()

    relay = Relay(ws, session["id"], config["diarize"], save_transcript)
    price = PRICE_PER_HOUR
    bytes_per_second = config["sample_rate"] * 2  # 16-bit mono PCM
    sent_bytes = 0
    saved_seconds = 0.0

    def save_usage() -> dict:
        # Prefer xAI's own figure once it reports one; otherwise count the audio we forwarded.
        seconds = relay.reported_duration if relay.reported_duration is not None else sent_bytes / bytes_per_second
        cost = seconds / 3600 * price
        store().record_usage(session["id"], seconds, cost)
        return {"audio_seconds": seconds, "cost_usd": cost}

    saving = None
    if saver:
        saving = {
            "folder": str(saver.folder),
            "transcript": bool(saver.transcript_path),
            # "recorder": the browser sends compressed audio; "wav": the server writes the PCM it relays.
            "audio": None if not saver.audio_path else "wav" if saver.wav else "recorder",
        }
    await ws.send_json({"type": "ready", "session": session, "price_per_hour": price, "saving": saving})

    async def pump_audio() -> str:
        nonlocal sent_bytes, saved_seconds
        while True:
            try:
                msg = await ws.recv()
            except ConnectionClosed:
                return "disconnect"
            if isinstance(msg, bytes):
                if not msg:
                    continue
                await upstream.send(msg)
                sent_bytes += len(msg)
                if saver and saver.wav:
                    saver.add_audio(msg)
                    await report_save_problem()
                # Save usage every ~10 s so it isn't lost if the app is closed mid-recording.
                if sent_bytes / bytes_per_second - saved_seconds >= 10:
                    saved_seconds = save_usage()["audio_seconds"]
            else:
                message = json.loads(msg)
                if message.get("type") == "stop":
                    await upstream.send(json.dumps({"type": "audio.done"}))
                    return "stop"
                if message.get("type") == "audio-file" and saver and not saver.wav:
                    saver.add_audio(base64.b64decode(message.get("data") or ""))
                    await report_save_problem()

    async def pump_events() -> None:
        try:
            while True:
                raw = await upstream.recv()
                ev = json.loads(raw)
                if DEBUG_EVENTS:
                    print("xAI event:", raw if isinstance(raw, str) else raw[:200], flush=True)
                await relay.handle(ev)
                if ev.get("type") == "transcript.done":
                    return
        except ConnectionClosed:
            pass

    audio_task = asyncio.create_task(pump_audio())
    events_task = asyncio.create_task(pump_events())
    try:
        done, _ = await asyncio.wait({audio_task, events_task}, return_when=asyncio.FIRST_COMPLETED)
        if audio_task in done and audio_task.result() == "stop":
            # Let xAI flush the last utterance before we close.
            await asyncio.wait({events_task}, timeout=15)
            await ws.send_json({"type": "done", "session_id": session["id"], "usage": save_usage(), "saved": finish_saving()})
        elif events_task in done:
            await ws.send_json({"type": "error", "message": "xAI closed the stream."})
    except ConnectionClosed:
        pass
    except Exception as e:
        print("relay error:", repr(e), file=sys.stderr, flush=True)
    finally:
        for task in (audio_task, events_task):
            task.cancel()
        await upstream.close()
        save_usage()
        store().end_session(session["id"])
        finish_saving()  # no-op if the recording already stopped normally
        await ws.close()


async def serve_socket(sock) -> None:
    await transcribe(await websocket.from_socket(sock))


def run_socket(sock) -> None:
    """Run one recording on the thread serve.py gave this connection."""
    try:
        asyncio.run(serve_socket(sock))
    except Exception:
        traceback.print_exc()


def upgrade(method: str, headers) -> Response:
    key = headers.get("Sec-WebSocket-Key", "")
    if method != "GET" or headers.get("Upgrade", "").lower() != "websocket" or not key:
        return json_response({"error": "expected a WebSocket upgrade"}, 400)
    return Response(101, websocket.upgrade_headers(key), b"", run_socket)


# ---------- Routing ----------

ROUTES = [
    ("GET", r"/api/sessions", list_sessions),
    ("GET", r"/api/sessions/(\d+)", get_session),
    ("PATCH", r"/api/sessions/(\d+)", update_session),
    ("DELETE", r"/api/sessions/(\d+)", delete_session),
    ("GET", r"/api/sessions/(\d+)/export", export_session),
    ("GET", r"/api/settings", get_settings),
    ("PUT", r"/api/settings", update_settings),
    ("POST", r"/api/settings/test", test_settings),
    ("POST", r"/api/models", list_models),
    ("POST", r"/api/folder/choose", choose_folder),
    ("POST", r"/api/sessions/(\d+)/reveal", reveal_session),
    ("GET", r"/api/usage", get_usage),
]


def handles(target: str) -> bool:
    """True for the URLs Scribe answers. serve.py serves everything else as files."""
    path = target.split("?", 1)[0]
    return path.startswith("/api/") or path == SOCKET_PATH


def handle(method: str, target: str, headers, body: bytes) -> Response:
    """Answer one request passed on by serve.py."""
    if not local_request(headers):
        return json_response({"error": "forbidden"}, 403)
    parts = urllib.parse.urlsplit(target)
    if parts.path == SOCKET_PATH:
        return upgrade(method, headers)

    handler, match, known_path = None, None, False
    for route_method, pattern, route_handler in ROUTES:
        found = re.fullmatch(pattern, parts.path)
        if found:
            known_path = True
            if route_method == method:
                handler, match = route_handler, found
                break
    if handler is None:
        if known_path:
            return json_response({"error": "method not allowed"}, 405)
        return json_response({"error": "not found"}, 404)

    try:
        data = json.loads(body) if body else {}
    except ValueError:
        return json_response({"error": "invalid JSON"}, 400)
    if not isinstance(data, dict):
        return json_response({"error": "expected a JSON object"}, 400)
    request = Request(
        int(match.group(1)) if match.groups() else None,
        dict(urllib.parse.parse_qsl(parts.query)),
        data,
    )
    try:
        return handler(request)
    except Exception:
        traceback.print_exc()
        return json_response({"error": "server error"}, 500)
