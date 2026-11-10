from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

DEFAULT_DB_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "zhibo_history.db"
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    goal TEXT,
    stage TEXT,
    created_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    plan_json TEXT,
    metrics_json TEXT,
    summary_json TEXT,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    agent TEXT,
    action TEXT,
    trigger TEXT,
    risk TEXT,
    confidence REAL,
    status TEXT,
    trace_id TEXT,
    latency_ms REAL,
    reasoning TEXT,
    evidence_json TEXT,
    consensus_json TEXT,
    created_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    metrics_json TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT,
    content_json TEXT,
    created_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON metrics_history(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_log(session_id);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


def _dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _loads(value):
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


class Persistence:
    """基于 sqlite3 的本地持久化层，零第三方依赖。

    负责会话历史、决策卡片、指标序列与对话记录的落盘，
    让重启后仍可回溯历史场次。
    """

    def __init__(self, db_path=None) -> None:
        self.db_path = db_path or DEFAULT_DB_PATH
        self._lock = threading.RLock()
        self._ensure_dir()
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            conn.commit()

    def _ensure_dir(self) -> None:
        directory = os.path.dirname(self.db_path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory, exist_ok=True)

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def upsert_session(self, session, *, plan=None, metrics=None, summary=None) -> None:
        if not isinstance(session, dict) or not session.get("id"):
            return
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO sessions (id, title, goal, stage, created_at, started_at, ended_at,
                                          plan_json, metrics_json, summary_json, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title, goal=excluded.goal, stage=excluded.stage,
                        started_at=excluded.started_at, ended_at=excluded.ended_at,
                        plan_json=excluded.plan_json, metrics_json=excluded.metrics_json,
                        summary_json=excluded.summary_json, updated_at=excluded.updated_at
                    """,
                    (
                        session["id"],
                        session.get("title"),
                        session.get("goal"),
                        session.get("stage"),
                        session.get("createdAt"),
                        session.get("startedAt"),
                        session.get("endedAt"),
                        _dumps(plan),
                        _dumps(metrics),
                        _dumps(summary),
                        _now_ms(),
                    ),
                )
                conn.commit()

    def save_decision(self, decision, *, session_id=None) -> None:
        if not isinstance(decision, dict) or not decision.get("id"):
            return
        sid = decision.get("sessionId") or session_id
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO decisions
                        (id, session_id, agent, action, trigger, risk, confidence,
                         status, trace_id, latency_ms, reasoning, evidence_json,
                         consensus_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        decision["id"],
                        sid,
                        decision.get("agent"),
                        decision.get("action"),
                        decision.get("trigger"),
                        decision.get("risk"),
                        decision.get("confidence"),
                        decision.get("status"),
                        decision.get("traceId"),
                        decision.get("latencyMs"),
                        decision.get("reasoning"),
                        _dumps(decision.get("evidence")),
                        _dumps(decision.get("consensus")),
                        decision.get("at") or _now_ms(),
                    ),
                )
                conn.commit()

    def save_metrics(self, session_id, metrics) -> None:
        if not session_id or not isinstance(metrics, dict):
            return
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO metrics_history (session_id, metrics_json, recorded_at) VALUES (?, ?, ?)",
                    (session_id, _dumps(metrics), _now_ms()),
                )
                conn.commit()

    def save_chat(self, session_id, role, content) -> None:
        if not session_id:
            return
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO chat_log (session_id, role, content_json, created_at) VALUES (?, ?, ?, ?)",
                    (session_id, role, _dumps(content), _now_ms()),
                )
                conn.commit()

    def list_sessions(self, limit=20):
        with self._lock:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM sessions ORDER BY COALESCE(created_at, updated_at) DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [self._session_row(row) for row in rows]

    def get_session(self, session_id):
        with self._lock:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT * FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
        return self._session_row(row) if row else None

    def get_decisions(self, session_id, limit=100):
        with self._lock:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
                    (session_id, limit),
                ).fetchall()
        return [self._decision_row(row) for row in rows]

    def get_metrics_history(self, session_id, limit=500):
        with self._lock:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT metrics_json, recorded_at FROM metrics_history "
                    "WHERE session_id = ? ORDER BY recorded_at ASC LIMIT ?",
                    (session_id, limit),
                ).fetchall()
        return [
            {**(_loads(row["metrics_json"]) or {}), "recordedAt": row["recorded_at"]}
            for row in rows
        ]

    def get_chat_log(self, session_id, limit=200):
        with self._lock:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT role, content_json, created_at FROM chat_log "
                    "WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
                    (session_id, limit),
                ).fetchall()
        return [
            {"role": row["role"], "content": _loads(row["content_json"]), "at": row["created_at"]}
            for row in rows
        ]

    def snapshot(self):
        with self._lock:
            with self._connect() as conn:
                session_count = conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()["c"]
                decision_count = conn.execute("SELECT COUNT(*) AS c FROM decisions").fetchone()["c"]
                metrics_count = conn.execute("SELECT COUNT(*) AS c FROM metrics_history").fetchone()["c"]
                chat_count = conn.execute("SELECT COUNT(*) AS c FROM chat_log").fetchone()["c"]
        return {
            "dbPath": self.db_path,
            "sessions": session_count,
            "decisions": decision_count,
            "metricsPoints": metrics_count,
            "chatMessages": chat_count,
            "storage": "sqlite3 · 本地持久化 · 零第三方依赖",
        }

    @staticmethod
    def _session_row(row):
        return {
            "id": row["id"],
            "title": row["title"],
            "goal": row["goal"],
            "stage": row["stage"],
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "endedAt": row["ended_at"],
            "plan": _loads(row["plan_json"]),
            "metrics": _loads(row["metrics_json"]),
            "summary": _loads(row["summary_json"]),
        }

    @staticmethod
    def _decision_row(row):
        return {
            "id": row["id"],
            "sessionId": row["session_id"],
            "agent": row["agent"],
            "action": row["action"],
            "trigger": row["trigger"],
            "risk": row["risk"],
            "confidence": row["confidence"],
            "status": row["status"],
            "traceId": row["trace_id"],
            "latencyMs": row["latency_ms"],
            "reasoning": row["reasoning"],
            "evidence": _loads(row["evidence_json"]),
            "consensus": _loads(row["consensus_json"]),
            "at": row["created_at"],
        }
