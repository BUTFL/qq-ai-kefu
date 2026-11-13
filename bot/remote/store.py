"""远程协助的留痕存储。SQLite，标准库 sqlite3，跟入群审批那个库同一个套路。

为什么不复用 `data/qa.db` 的 handoffs 表：那张表的语义是「客户在等谁回话」，状态只有
等人工/接管/结束三个；远程协助要记的是**识别码、谁同意的、连了几次**，混进去会让
`/会话` 列表里冒出一堆不像会话的东西。独立一张表、独立一个库，坏也坏不到问答上。

必须存库的理由跟审批一样：
1. 大哥点头要用短编号（`/连 3`），编号得跨重启存在；
2. 「谁同意的、什么时候、连的是哪台」是审计要求；
3. 重启后等点头的单子还在，不然客户白等。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = ROOT / "data" / "remote.db"

# 状态机：
#
#   已问客户 ──客户说有──▶ 等识别码 ──收到码──▶ 等大哥点头 ──/连──▶ 已连上 ──/远程断──▶ 结束
#        │                      │                  │
#        └──客户说没有──▶ 取消    └──超时──▶ 失效     └──/不连──▶ 已拒绝
#
# **「已连上」只能由 /连 进入**（`approve` 之后才 `connect`）。没别的入口。
ASKED = "asked"            # 已经私聊问过客户「有没有向日葵」，等回话
COLLECTING = "collecting"  # 客户说有，等他发识别码
WAITING = "waiting"        # 识别码到手，等大哥点头
CONNECTED = "connected"    # 已连上，正在帮他弄
DONE = "done"              # 结束
CANCELLED = "cancelled"    # 客户说没有 / 自己放弃
REJECTED = "rejected"      # 大哥点了 /不连
EXPIRED = "expired"        # 等超时

OPEN_STATES = (ASKED, COLLECTING, WAITING, CONNECTED)
CLOSED_STATES = (DONE, CANCELLED, REJECTED, EXPIRED)
STATE_CN = {
    ASKED: "已问客户", COLLECTING: "等识别码", WAITING: "等大哥点头",
    CONNECTED: "已连上", DONE: "已结束", CANCELLED: "客户放弃了",
    REJECTED: "已拒绝", EXPIRED: "等超时失效",
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS assist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL DEFAULT 0,
    user_id     INTEGER NOT NULL,
    nickname    TEXT    NOT NULL DEFAULT '',
    target      TEXT    NOT NULL DEFAULT '',   -- 识别码/设备码。本地留档，审计要
    state       TEXT    NOT NULL,
    provider    TEXT    NOT NULL DEFAULT 'awesun',
    source      TEXT    NOT NULL DEFAULT '客户自己问',  -- 客户自己问 / 自己人叫的
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    approved_by INTEGER,
    approved_at TEXT,
    ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_assist_state ON assist(state);
CREATE INDEX IF NOT EXISTS idx_assist_user ON assist(user_id, state);
"""


@dataclass(frozen=True)
class Assist:
    id: int
    group_id: int
    user_id: int
    nickname: str
    target: str
    state: str
    provider: str
    source: str
    note: str
    created_at: str
    updated_at: str
    approved_by: int | None
    approved_at: str | None
    ended_at: str | None

    @property
    def who(self) -> str:
        return f"{self.nickname}({self.user_id})" if self.nickname else str(self.user_id)

    @property
    def is_open(self) -> bool:
        return self.state in OPEN_STATES


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class RemoteStore:
    def __init__(self, path: Path = DB_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    # ---- 建单 / 查 ----

    def open_of(self, user_id: int) -> Assist | None:
        """这个客户手上还没结的单。有就不要再问一遍「你有没有向日葵」。"""
        row = self._db.execute(
            f"SELECT * FROM assist WHERE user_id=? AND state IN ({_ph(OPEN_STATES)}) ORDER BY id DESC LIMIT 1",
            (user_id, *_tuple(OPEN_STATES)),
        ).fetchone()
        return Assist(**dict(row)) if row else None

    def create(self, *, user_id: int, nickname: str, group_id: int = 0, provider: str = "awesun",
               source: str = "客户自己问") -> int:
        cur = self._db.execute(
            "INSERT INTO assist (group_id, user_id, nickname, state, provider, source, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (group_id, user_id, nickname, ASKED, provider, source, _now(), _now()),
        )
        self._db.commit()
        return int(cur.lastrowid or 0)

    def get(self, rec_id: int) -> Assist | None:
        row = self._db.execute("SELECT * FROM assist WHERE id=?", (rec_id,)).fetchone()
        return Assist(**dict(row)) if row else None

    def by_state(self, *states: str, limit: int = 30) -> list[Assist]:
        rows = self._db.execute(
            f"SELECT * FROM assist WHERE state IN ({_ph(states)}) ORDER BY id LIMIT ?",
            (*_tuple(states), limit),
        ).fetchall()
        return [Assist(**dict(r)) for r in rows]

    def open_all(self, limit: int = 30) -> list[Assist]:
        return self.by_state(*OPEN_STATES, limit=limit)

    def asked_within(self, user_id: int, hours: float) -> bool:
        """最近 hours 小时内问过这个人没有。防止同一个客户被反复问「要不要远程」。"""
        since = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        row = self._db.execute(
            "SELECT 1 FROM assist WHERE user_id=? AND created_at >= ? LIMIT 1", (user_id, since)
        ).fetchone()
        return row is not None

    def open_count(self) -> int:
        row = self._db.execute(
            f"SELECT COUNT(*) c FROM assist WHERE state IN ({_ph(OPEN_STATES)})", _tuple(OPEN_STATES)
        ).fetchone()
        return int(row["c"])

    # ---- 改状态 ----

    def set_state(self, rec_id: int, state: str, *, note: str = "", target: str = "") -> None:
        sets = ["state=?", "updated_at=?"]
        vals: list[object] = [state, _now()]
        if note:
            sets.append("note=?")
            vals.append(note)
        if target:
            sets.append("target=?")
            vals.append(target)
        if state in CLOSED_STATES:
            sets.append("ended_at=?")
            vals.append(_now())
        vals.append(rec_id)
        self._db.execute(f"UPDATE assist SET {', '.join(sets)} WHERE id=?", vals)
        self._db.commit()

    def approve(self, rec_id: int, by: int) -> None:
        """大哥点头。**这是「能不能连」的唯一开关**，别的地方不许写 approved_by。"""
        self._db.execute(
            "UPDATE assist SET approved_by=?, approved_at=?, updated_at=? WHERE id=?",
            (by, _now(), _now(), rec_id),
        )
        self._db.commit()

    def touch(self, rec_id: int) -> None:
        self._db.execute("UPDATE assist SET updated_at=? WHERE id=?", (_now(), rec_id))
        self._db.commit()


def _ph(items: tuple[str, ...] | list[str]) -> str:
    return ",".join("?" * len(items))


def _tuple(items: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    return tuple(items)
