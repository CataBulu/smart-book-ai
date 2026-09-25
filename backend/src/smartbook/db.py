"""SQLite persistence: books (source of truth), conversations, messages, usage events."""

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT NOT NULL,
    genres TEXT NOT NULL DEFAULT '[]',
    themes TEXT NOT NULL DEFAULT '[]',
    text TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    chunks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS books_title_author ON books (lower(title), lower(author));
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT,
    blocked INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    conversation_id TEXT,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost REAL NOT NULL,
    created_at TEXT NOT NULL
);
"""

BOOK_COLUMNS = "id, title, author, description, genres, themes, source, chunks, cover, created_at"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _book(row: sqlite3.Row) -> dict:
    book = dict(row)
    book["genres"] = json.loads(book["genres"])
    book["themes"] = json.loads(book["themes"])
    cover = book.pop("cover", None)
    if "id" in book:
        book["cover_url"] = f"/api/media/covers/{cover}" if cover else None
    return book


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(SCHEMA)
        if "cover" not in {r["name"] for r in self.conn.execute("PRAGMA table_info(books)")}:
            self.conn.execute("ALTER TABLE books ADD COLUMN cover TEXT")  # added in round 2
        self.lock = threading.Lock()

    def _write(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self.lock, self.conn:
            return self.conn.execute(sql, params)

    def _all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    # --- books -------------------------------------------------------------
    def insert_book(self, book: dict, chunks: int) -> dict:
        book_id = new_id()
        self._write(
            "INSERT INTO books (id, title, author, description, genres, themes, text, source, chunks, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (book_id, book["title"], book["author"], book["description"], json.dumps(book["genres"]),
             json.dumps(book["themes"]), book.get("text", ""), book.get("source", "manual"), chunks, now()),
        )
        return self.get_book(book_id)

    def get_book(self, book_id: str) -> dict | None:
        rows = self._all(f"SELECT {BOOK_COLUMNS} FROM books WHERE id = ?", (book_id,))
        return _book(rows[0]) if rows else None

    def find_book(self, title: str) -> dict | None:
        """Exact case-insensitive title match first, then substring match."""
        title = title.strip().strip('"*').strip()
        for sql, param in (("lower(title) = lower(?)", title), ("lower(title) LIKE lower(?)", f"%{title}%")):
            rows = self._all(f"SELECT {BOOK_COLUMNS} FROM books WHERE {sql} ORDER BY length(title) LIMIT 1", (param,))
            if rows:
                return _book(rows[0])
        return None

    def book_exists(self, title: str, author: str) -> bool:
        return bool(self._all("SELECT 1 FROM books WHERE lower(title) = lower(?) AND lower(author) = lower(?)",
                              (title, author)))

    def list_books(self) -> list[dict]:
        return [_book(r) for r in self._all(f"SELECT {BOOK_COLUMNS} FROM books ORDER BY lower(title)")]

    def export_books(self) -> list[dict]:
        rows = self._all("SELECT title, author, description, genres, themes, text FROM books ORDER BY lower(title)")
        return [_book(r) for r in rows]

    def set_cover(self, book_id: str, filename: str | None) -> None:
        self._write("UPDATE books SET cover = ? WHERE id = ?", (filename, book_id))

    def delete_book(self, book_id: str) -> bool:
        return self._write("DELETE FROM books WHERE id = ?", (book_id,)).rowcount > 0

    def count_books(self) -> int:
        return self._all("SELECT count(*) FROM books")[0][0]

    # --- conversations -----------------------------------------------------
    def create_conversation(self, title: str) -> dict:
        conv = {"id": new_id(), "title": title, "created_at": now(), "updated_at": now()}
        self._write("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    tuple(conv.values()))
        return conv

    def get_conversation(self, conv_id: str) -> dict | None:
        rows = self._all("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?", (conv_id,))
        return dict(rows[0]) if rows else None

    def list_conversations(self) -> list[dict]:
        return [dict(r) for r in self._all("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC")]

    def delete_conversation(self, conv_id: str) -> bool:
        return self._write("DELETE FROM conversations WHERE id = ?", (conv_id,)).rowcount > 0

    def count_conversations(self) -> int:
        return self._all("SELECT count(*) FROM conversations")[0][0]

    # --- messages ----------------------------------------------------------
    def add_message(self, conv_id: str, role: str, content: str, sources: list | None = None, blocked: bool = False,
                    prompt_tokens: int = 0, completion_tokens: int = 0, cost: float = 0.0) -> str:
        msg_id = new_id()
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, sources, blocked, prompt_tokens,"
                " completion_tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (msg_id, conv_id, role, content, json.dumps(sources) if sources is not None else None, int(blocked),
                 prompt_tokens, completion_tokens, cost, now()),
            )
            self.conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now(), conv_id))
        return msg_id

    def messages(self, conv_id: str, limit: int | None = None) -> list[dict]:
        """Oldest-first; with `limit`, only the most recent `limit` messages."""
        rows = self._all(
            "SELECT * FROM (SELECT rowid AS seq, id, role, content, sources, blocked, prompt_tokens, completion_tokens,"
            " cost, created_at FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
            (conv_id, limit if limit is not None else -1),
        )
        out = []
        for r in rows:
            m = dict(r)
            del m["seq"]
            m["sources"] = json.loads(m["sources"]) if m["sources"] else []
            m["blocked"] = bool(m["blocked"])
            out.append(m)
        return out

    # --- usage -------------------------------------------------------------
    def add_usage(self, session_id: str, conv_id: str | None, model: str, purpose: str,
                  prompt_tokens: int, completion_tokens: int, cost: float) -> None:
        self._write(
            "INSERT INTO usage (session_id, conversation_id, model, purpose, prompt_tokens, completion_tokens, cost,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, conv_id, model, purpose, prompt_tokens, completion_tokens, cost, now()),
        )

    def usage_summary(self, session_id: str) -> dict:
        sql = ("SELECT coalesce(sum(cost), 0), coalesce(sum(prompt_tokens + completion_tokens), 0),"
               " count(*) FILTER (WHERE purpose != 'moderation_block'),"
               " count(*) FILTER (WHERE purpose = 'moderation_block') FROM usage")

        def row(where: str = "", params: tuple = ()) -> dict:
            cost, tokens, calls, blocked = self._all(sql + where, params)[0]
            return {"cost": round(cost, 6), "tokens": tokens, "calls": calls, "blocked": blocked}

        return {"session": row(" WHERE session_id = ?", (session_id,)), "total": row(),
                "conversations": self.count_conversations()}
