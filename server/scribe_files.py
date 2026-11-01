"""Saving Scribe recordings to a folder on this computer.

Each recording gets two files with the same name: the transcript (.md or .txt),
rewritten whenever a line is finished, and the audio, appended while it is
recorded. Closing the window mid-recording keeps everything saved so far.
"""

from __future__ import annotations

import os
import re
import struct
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

# Compressed audio comes from the browser's MediaRecorder; its type picks the file suffix.
RECORDER_SUFFIXES = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a"}
UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
DEFAULT_TITLE = re.compile(r"^Recording \d{2} \w{3} \d{4}, \d{2}:\d{2}$")
WAV_PATCH_EVERY = 10  # seconds of audio between WAV header updates

PICKER = r"""
import sys
import tkinter
from tkinter import filedialog

sys.stdout.reconfigure(encoding="utf-8")
root = tkinter.Tk()
root.withdraw()
root.attributes("-topmost", True)
path = filedialog.askdirectory(
    parent=root, initialdir=sys.argv[1] or None, mustexist=False,
    title="Choose where Scribe saves recordings",
)
print(path or "")
"""


def default_folder() -> Path:
    documents = Path.home() / "Documents"
    return (documents if documents.is_dir() else Path.home()) / "Scribe"


def check_folder(folder: Path) -> str | None:
    """Create the folder if needed and make sure files can be written there. Returns a problem, or None."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        probe = folder / f".scribe-check-{os.getpid()}"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as e:
        return f"Can't save to {folder}: {e.strerror or e}"
    return None


def recorder_suffix(audio_type: str) -> str | None:
    return RECORDER_SUFFIXES.get(audio_type.split(";")[0].strip().lower())


def base_name(session: dict) -> str:
    """"2026-11-01 17.34 Lecture 3a": the start time, then the title (or just "Recording")."""
    started = datetime.fromisoformat(session["started_at"]).astimezone()
    title = session["title"]
    title = "Recording" if DEFAULT_TITLE.match(title) else re.sub(r"\s+", " ", UNSAFE.sub("", title)).strip(" .")[:80].rstrip(" .")
    return f"{started:%Y-%m-%d %H.%M} {title or 'Recording'}"


def unique_base(folder: Path, base: str, suffixes: list[str], keep: tuple = ()) -> str:
    """base, or "base (2)", "base (3)"… so no existing file is overwritten."""
    candidate, n = base, 2
    while any((folder / f"{candidate}{s}").exists() and (folder / f"{candidate}{s}") not in keep for s in suffixes):
        candidate, n = f"{base} ({n})", n + 1
    return candidate


def wav_header(rate: int, size: int) -> bytes:
    """A 44-byte header for 16-bit mono PCM."""
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + size, b"WAVE", b"fmt ", 16, 1, 1,
                       rate, rate * 2, 2, 16, b"data", size)


def write_text(path: Path, text: str) -> None:
    """Replace the file in one step, so a reader never sees half of it."""
    temp = path.with_name(f".{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    temp.write_text(text, encoding="utf-8")
    os.replace(str(temp), str(path))


class Saver:
    """Writes one recording's transcript and audio while it runs."""

    def __init__(self, folder: Path, transcript_format: str | None, audio_suffix: str | None):
        self.folder = folder
        self.transcript_format = transcript_format  # "md", "txt", or None for no transcript file
        self.audio_suffix = audio_suffix  # ".wav", ".webm"…, or None for no audio file
        self.transcript_path: Path | None = None
        self.audio_path: Path | None = None
        self.audio_file = None
        self.wav_rate = 0
        self.wav_size = 0
        self.wav_patched = 0
        self.problem: str | None = None
        self.reported = False
        self.finished = False

    @property
    def wav(self) -> bool:
        return self.audio_suffix == ".wav"

    def fail(self, e: OSError) -> None:
        if not self.problem:
            self.problem = f"Couldn't save to {self.folder}: {e.strerror or e}. Scribe's own copy is unaffected."

    def unreported_problem(self) -> str | None:
        if self.problem and not self.reported:
            self.reported = True
            return self.problem
        return None

    def start(self, session: dict, sample_rate: int) -> None:
        suffixes = [s for s in (f".{self.transcript_format}" if self.transcript_format else None, self.audio_suffix) if s]
        base = unique_base(self.folder, base_name(session), suffixes)
        if self.transcript_format:
            self.transcript_path = self.folder / f"{base}.{self.transcript_format}"
        if self.audio_suffix:
            self.audio_path = self.folder / f"{base}{self.audio_suffix}"
            try:
                self.audio_file = open(str(self.audio_path), "wb")
                if self.wav:
                    self.wav_rate = sample_rate
                    self.audio_file.write(wav_header(sample_rate, 0))
            except OSError as e:
                self.fail(e)

    def add_audio(self, data: bytes) -> None:
        if self.audio_file is None or self.problem:
            return
        try:
            self.audio_file.write(data)
            self.audio_file.flush()
            if self.wav:
                self.wav_size += len(data)
                # Keep the header current, so a recording cut off mid-way still plays.
                if self.wav_size - self.wav_patched >= WAV_PATCH_EVERY * self.wav_rate * 2:
                    self.patch_wav()
        except OSError as e:
            self.fail(e)

    def patch_wav(self) -> None:
        self.audio_file.seek(0)
        self.audio_file.write(wav_header(self.wav_rate, self.wav_size))
        self.audio_file.seek(0, os.SEEK_END)
        self.audio_file.flush()
        self.wav_patched = self.wav_size

    def write_transcript(self, text: str) -> None:
        if self.transcript_path is None:
            return
        try:
            write_text(self.transcript_path, text)
        except OSError as e:
            self.fail(e)

    def close(self) -> None:
        if self.audio_file is None:
            return
        try:
            if self.wav:
                self.patch_wav()
            self.audio_file.close()
        except OSError as e:
            self.fail(e)
        self.audio_file = None

    def paths(self) -> dict:
        return {"transcript": str(self.transcript_path) if self.transcript_path else None,
                "audio": str(self.audio_path) if self.audio_path else None}


def rename_files(session: dict) -> dict:
    """Give a finished recording's saved files its current title. Returns the paths now in use."""
    current = [Path(p) for p in (session.get("transcript_path"), session.get("audio_path")) if p]
    existing = [p for p in current if p.exists()]
    paths = {"transcript": session.get("transcript_path"), "audio": session.get("audio_path")}
    if not existing:
        return paths
    folder = existing[0].parent
    wanted = base_name(session)
    if all(p.stem == wanted for p in existing):
        return paths
    base = unique_base(folder, wanted, [p.suffix for p in existing], keep=tuple(existing))
    for p in existing:
        target = folder / f"{base}{p.suffix}"
        try:
            p.rename(target)
        except OSError:
            continue  # open in another program, perhaps; keep the old name
        key = "audio" if str(p) == session.get("audio_path") else "transcript"
        paths[key] = str(target)
    return paths


def choose_folder(initial: str) -> tuple[str | None, str | None]:
    """Show the system's folder picker, in its own process. Returns (path, problem); path is "" if cancelled."""
    try:
        result = subprocess.run([sys.executable, "-c", PICKER, initial], capture_output=True, timeout=900)
    except (OSError, subprocess.TimeoutExpired):
        return None, "The folder picker didn't open. Type the folder's path instead."
    if result.returncode != 0:
        if b"tkinter" in result.stderr:
            return None, "This Python has no folder picker (tkinter). Type the folder's path instead."
        return None, "The folder picker didn't open. Type the folder's path instead."
    chosen = result.stdout.decode("utf-8", "replace").strip()
    return (str(Path(chosen)) if chosen else ""), None


def reveal(path: Path) -> None:
    """Show a saved file in the system's file manager."""
    if sys.platform.startswith("win"):
        subprocess.Popen(f'explorer /select,"{path}"')  # Explorer wants exactly this quoting
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])
