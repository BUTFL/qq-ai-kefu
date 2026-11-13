"""入群审批的留痕存储。SQLite，标准库 sqlite3，不加依赖。

为什么必须存库而不是内存字典：
1. 超管私聊要用短编号（flag 是一长串，手机上没法手打），编号得跨重启存在；
2. 「谁批的、什么时候、什么理由」是审计要求（方案 §53）；
3. 重启后待批列表还在，不然一重启就丢单。

sqlite3 是同步阻塞的，这里没包 to_thread——这个机器人一天也就几条审批，
单次读写是亚毫秒级，为它引入线程池不值得。真到了每秒几十条再说。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "approvals.db"

# 状态机。「规则自动放行」和「超管人工批准」分成两个状态：事后要能一眼分清
# 哪些人是机器自己放进去的、哪些是人点头的，出事了才追得回来。
PENDING = "pending"  # 等超管发指令
AUTO_APPROVED = "auto_approved"  # 规则命中，自动放行
APPROVED = "approved"  # 超管人工批准（走机器人的 /y）
REJECTED = "rejected"  # 超管人工拒绝
EXPIRED = "expired"  # flag 失效（别人先处理了 / 超出 NapCat 的回溯窗口）
FAILED = "failed"  # 调接口报错
# 在 QQ 上直接点的同意，没走机器人。机器人是看见这人进群了才知道的（notice.group_increase）。
# 2026-10-08 加：之前这种情况库里一直留着 pending，待批数越积越多且是虚的 ——
# 11 条待批里 5 个人其实早在群里了。谁点的同意、什么理由都查不到，所以单独一个状态，
# 不混进 APPROVED（那个的 decided_by 是真有人）
JOINED = "joined"

DONE_STATES = {AUTO_APPROVED, APPROVED, REJECTED, EXPIRED, FAILED, JOINED}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS approvals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    flag           TEXT    NOT NULL UNIQUE,
    sub_type       TEXT    NOT NULL DEFAULT 'add',
    group_id       INTEGER NOT NULL DEFAULT 0,
    group_name     TEXT    NOT NULL DEFAULT '',
    user_id        INTEGER NOT NULL DEFAULT 0,
    nickname       TEXT    NOT NULL DEFAULT '',
    comment        TEXT    NOT NULL DEFAULT '',
    rule           TEXT    NOT NULL DEFAULT '',
    source         TEXT    NOT NULL DEFAULT '事件',
    status         TEXT    NOT NULL DEFAULT 'pending',
    created_at     TEXT    NOT NULL,
    decided_by     INTEGER,
    decided_reason TEXT    NOT NULL DEFAULT '',
    decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
-- 被封禁的人（2026-10-09 他要的「被我踢出的人下次申请就不同意」，**所有群都拦**，永久）。
-- 一人一行：在哪个群被踢的、谁踢的只留最后一次，留着好查。note 是页面上手动封时写的备注
CREATE TABLE IF NOT EXISTS banned (
    user_id        INTEGER PRIMARY KEY,
    group_id       INTEGER NOT NULL DEFAULT 0,
    operator_id    INTEGER NOT NULL DEFAULT 0,
    source         TEXT    NOT NULL DEFAULT 'kick',
    note           TEXT    NOT NULL DEFAULT '',
    banned_at      TEXT    NOT NULL
);
"""


@dataclass(frozen=True)
class Record:
    id: int
    flag: str
    sub_type: str
    group_id: int
    group_name: str
    user_id: int
    nickname: str
    comment: str
    rule: str
    source: str
    status: str
    created_at: str
    decided_by: int | None
    decided_reason: str
    decided_at: str | None

    @property
    def who(self) -> str:
        """展示用。判断身份一律用 user_id——昵称能重名、能改。"""
        return f"{self.nickname}({self.user_id})" if self.nickname else str(self.user_id)

    @property
    def where(self) -> str:
        return f"{self.group_id}「{self.group_name}」" if self.group_name else str(self.group_id)


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class Store:
    def __init__(self, path: Path = DB_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.row_factory = sqlite3.Row
        # 2026-10-18 补：跟 kb/store.py 的 KBStore 同一个理由 —— rollback journal
        # 扛不住部署重启的写入中断，qa.db 已经坏过一回，approvals.db 别等第二次
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def add(
        self,
        *,
        flag: str,
        sub_type: str,
        group_id: int,
        group_name: str,
        user_id: int,
        nickname: str,
        comment: str,
        rule: str,
        source: str = "事件",
    ) -> int | None:
        """记一条待批。flag 重复返回 None——补拉历史申请时会和已收到的事件撞上，
        靠 UNIQUE 约束天然去重，不用先查后插（那样有竞态）。"""
        try:
            cur = self._db.execute(
                "INSERT INTO approvals (flag, sub_type, group_id, group_name, user_id,"
                " nickname, comment, rule, source, status, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (flag, sub_type, group_id, group_name, user_id, nickname, comment, rule, source, PENDING, _now()),
            )
        except sqlite3.IntegrityError:
            # **必须回滚**：sqlite3 在 INSERT 前自动开了事务，插失败了事务还开着、写锁一直攥着，
            # 别的进程（scripts/import_kicks.py 这种）就再也写不进这个库 —— 10-09 导入时撞上的。
            # 每次重连补拉都会撞上已经在库里的申请，所以这个锁基本一直都在
            self._db.rollback()
            return None
        self._db.commit()
        return int(cur.lastrowid or 0)

    def mark(self, rec_id: int, status: str, *, by: int | None = None, reason: str = "") -> None:
        self._db.execute(
            "UPDATE approvals SET status=?, decided_by=?, decided_reason=?, decided_at=? WHERE id=?",
            (status, by, reason, _now(), rec_id),
        )
        self._db.commit()

    def get(self, rec_id: int) -> Record | None:
        row = self._db.execute("SELECT * FROM approvals WHERE id=?", (rec_id,)).fetchone()
        return Record(**dict(row)) if row else None

    def pending(self, limit: int = 30) -> list[Record]:
        rows = self._db.execute(
            "SELECT * FROM approvals WHERE status=? ORDER BY id LIMIT ?", (PENDING, limit)
        ).fetchall()
        return [Record(**dict(r)) for r in rows]

    def pending_count(self) -> int:
        row = self._db.execute("SELECT COUNT(*) c FROM approvals WHERE status=?", (PENDING,)).fetchone()
        return int(row["c"])

    def pending_of(self, group_id: int, user_id: int) -> list[Record]:
        """这个人在这个群还挂着的待批申请。**可能有多条** —— 同一个人隔几分钟又申请一次
        （10-08 真有人连申请两次，#214 #215），他进群了就该一起结掉"""
        rows = self._db.execute(
            "SELECT * FROM approvals WHERE status=? AND group_id=? AND user_id=? ORDER BY id",
            (PENDING, group_id, user_id),
        ).fetchall()
        return [Record(**dict(r)) for r in rows]

    # ---- 被封禁的人 ----

    def ban(
        self, user_id: int, *, group_id: int = 0, operator_id: int = 0, source: str = "kick",
        note: str = "", at: str | None = None,
    ) -> None:
        """封一个人。**所有群都拦**，不分在哪个群被踢的。再封一次 = 更新成最后那次的群、操作人、时间。

        `source`：kick（看见你踢人自动记的）/ web（页面上手动加的）/ log（从旧日志导进来的）。
        `at` 给旧日志导入用，带上当时踢人的时间；不给就是现在
        """
        self._db.execute(
            "INSERT INTO banned (user_id, group_id, operator_id, source, note, banned_at) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(user_id) DO UPDATE SET group_id=excluded.group_id, operator_id=excluded.operator_id,"
            " source=excluded.source, banned_at=excluded.banned_at,"
            " note=CASE WHEN excluded.note != '' THEN excluded.note ELSE banned.note END",
            (user_id, group_id, operator_id, source, note, at or _now()),
        )
        self._db.commit()

    def unban(self, user_id: int) -> bool:
        cur = self._db.execute("DELETE FROM banned WHERE user_id=?", (user_id,))
        self._db.commit()
        return cur.rowcount > 0

    def is_banned(self, user_id: int) -> bool:
        return self._db.execute("SELECT 1 FROM banned WHERE user_id=?", (user_id,)).fetchone() is not None

    def banned(self) -> list[dict]:
        """全部被封的人，最近封的在前。顺带上他最后一次申请时的昵称（库里有的话），页面上好认人"""
        rows = self._db.execute(
            "SELECT b.*, (SELECT a.nickname FROM approvals a WHERE a.user_id=b.user_id AND a.nickname != ''"
            " ORDER BY a.id DESC LIMIT 1) AS nickname FROM banned b ORDER BY b.banned_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
