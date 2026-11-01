"""SQLite storage for Scribe: recordings (sessions) and their finished lines (segments)."""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    language       TEXT,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    model          TEXT,
    audio_seconds  REAL NOT NULL DEFAULT 0,
    cost_usd       REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS segments (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_ms    INTEGER NOT NULL,
    end_ms      INTEGER NOT NULL,
    speaker     TEXT,
    text        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);
"""

# Columns added after the first version; older databases get them on startup.
MIGRATIONS = {
    "model": "TEXT",
    "audio_seconds": "REAL NOT NULL DEFAULT 0",
    "cost_usd": "REAL NOT NULL DEFAULT 0",
    "transcript_path": "TEXT",  # copies saved to the user's folder, if any
    "audio_path": "TEXT",
}

TOTALS_SQL = """
    SELECT COALESCE(SUM(audio_seconds), 0) AS seconds,
           COALESCE(SUM(cost_usd), 0)      AS cost,
           COUNT(*)                        AS sessions
    FROM sessions
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        # serve.py answers each request on its own thread, so they share one
        # connection and take turns through the lock.
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        existing = {row["name"] for row in self.conn.execute("PRAGMA table_info(sessions)")}
        with self.conn:
            for column, decl in MIGRATIONS.items():
                if column not in existing:
                    self.conn.execute(f"ALTER TABLE sessions ADD COLUMN {column} {decl}")

    def create_session(self, language: str | None, model: str | None) -> dict:
        started = _now()
        title = "Recording " + datetime.now().strftime("%d %b %Y, %H:%M")
        with self.lock, self.conn:
            cur = self.conn.execute(
                "INSERT INTO sessions (title, language, model, started_at) VALUES (?, ?, ?, ?)",
                (title, language, model, started),
            )
        return self.get_session(cur.lastrowid)

    def record_usage(self, session_id: int, audio_seconds: float, cost_usd: float) -> None:
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET audio_seconds = ?, cost_usd = ? WHERE id = ?",
                (round(audio_seconds, 2), cost_usd, session_id),
            )

    def set_files(self, session_id: int, transcript_path: str | None, audio_path: str | None) -> None:
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET transcript_path = ?, audio_path = ? WHERE id = ?",
                (transcript_path, audio_path, session_id),
            )

    def end_session(self, session_id: int) -> None:
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
                (_now(), session_id),
            )

    def usage(self, days: int = 30) -> dict:
        def totals(where: str = "") -> dict:
            return dict(self.conn.execute(TOTALS_SQL + where).fetchone())

        with self.lock:
            daily = self.conn.execute(
                """
                SELECT date(started_at, 'localtime') AS day,
                       SUM(audio_seconds) AS seconds, SUM(cost_usd) AS cost, COUNT(*) AS sessions
                FROM sessions
                WHERE julianday(started_at) >= julianday('now', ?)
                GROUP BY day ORDER BY day DESC
                """,
                (f"-{days} days",),
            ).fetchall()
            return {
                "today": totals("WHERE date(started_at, 'localtime') = date('now', 'localtime')"),
                "month": totals(
                    "WHERE strftime('%Y-%m', started_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')"
                ),
                "total": totals(),
                "days": [dict(r) for r in daily],
            }

    def rename_session(self, session_id: int, title: str) -> None:
        with self.lock, self.conn:
            self.conn.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, session_id))

    def delete_session(self, session_id: int) -> None:
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def add_segment(self, session_id: int, start_ms: int, end_ms: int, speaker: str | None, text: str) -> dict:
        with self.lock, self.conn:
            cur = self.conn.execute(
                "INSERT INTO segments (session_id, start_ms, end_ms, speaker, text) VALUES (?, ?, ?, ?, ?)",
                (session_id, start_ms, end_ms, speaker, text),
            )
        return {"id": cur.lastrowid, "start_ms": start_ms, "end_ms": end_ms, "speaker": speaker, "text": text}

    def get_session(self, session_id: int) -> dict | None:
        with self.lock:
            row = self.conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return dict(row) if row else None

    def get_segments(self, session_id: int) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT id, start_ms, end_ms, speaker, text FROM segments WHERE session_id = ? ORDER BY id",
                (session_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def list_sessions(self, query: str = "") -> list[dict]:
        sql = """
            SELECT s.*,
                   COUNT(g.id) AS segment_count,
                   (SELECT text FROM segments WHERE session_id = s.id ORDER BY id LIMIT 1) AS preview
            FROM sessions s
            LEFT JOIN segments g ON g.session_id = s.id
        """
        params: tuple = ()
        if query:
            like = f"%{query}%"
            sql += """ WHERE s.title LIKE ?
                       OR EXISTS (SELECT 1 FROM segments WHERE session_id = s.id AND text LIKE ?)"""
            params = (like, like)
        sql += " GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC"
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]
