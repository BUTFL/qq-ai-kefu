"""每晚复盘完，把线上唯一的状态备份一份（2026-09-30 管理员选的）。

起因：qa.db 里是标准答案、附图对应、待办、审过的草稿、问答流水，最后一次进 git 是 09-28 凌晨，
之后新加的 56 条答案只在这一个文件里。git 也不是备份：他不提交就一直不进去。

备什么：qa.db、approvals.db（入群审批记录）、data/kb_images/（答案附图）。打成一个
`灵眸备份-YYYYMMDD-HHMM.tar.gz`，放 `BACKUP_DIR`（容器里挂的是宿主机 ~/linmu-backup/qa），留 `BACKUP_KEEP` 份。

- **数据库用 SQLite 自己的 backup 拷**，不是复制文件：机器人一直在写，直接 cp 可能拷到写了一半的页
- 拷出来的副本先跑一遍 integrity_check，过了才打包；先写 .part 再改名，打到一半断电不会留个坏包顶掉好的
- **不发任何通知**（他选的）：成功失败都只记日志。失败了明晚再备，旧的不删
"""
from __future__ import annotations

import logging
import sqlite3
import tarfile
import tempfile
from contextlib import closing
from datetime import datetime
from pathlib import Path

from ..store import DB_PATH as APPROVALS_DB
from .store import KB_IMAGE_DIR, KBStore

log = logging.getLogger(__name__)

PREFIX = "灵眸备份-"
SUFFIX = ".tar.gz"


class BackupError(RuntimeError):
    pass


def _check(path: Path) -> None:
    with closing(sqlite3.connect(path)) as db:
        got = db.execute("PRAGMA integrity_check").fetchone()[0]
    if got != "ok":
        raise BackupError(f"{path.name} 拷出来的副本自检没过：{got}")


def _copy_db(src: Path, dst: Path) -> None:
    with closing(sqlite3.connect(src)) as s, closing(sqlite3.connect(dst)) as d:
        s.backup(d)


def make(
    store: KBStore, dest: Path, *, keep: int = 14, now: datetime | None = None,
    approvals: Path = APPROVALS_DB, images: Path | None = None,
) -> Path:
    """备一份，返回备份文件路径；再删掉最老的，只留 keep 份。出错抛异常，旧备份不动"""
    images = KB_IMAGE_DIR if images is None else images
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"{PREFIX}{(now or datetime.now()):%Y%m%d-%H%M}{SUFFIX}"
    part = out.with_name(out.name + ".part")
    with tempfile.TemporaryDirectory(prefix="linmu-backup-") as tmp:
        qa = Path(tmp) / "qa.db"
        store.snapshot(qa)
        _check(qa)
        files = [qa]
        if approvals.exists():
            ap = Path(tmp) / "approvals.db"
            _copy_db(approvals, ap)
            _check(ap)
            files.append(ap)
        with tarfile.open(part, "w:gz") as tar:
            for f in files:
                tar.add(f, arcname=f.name)
            if images.is_dir():
                tar.add(images, arcname="kb_images")
    part.replace(out)
    prune(dest, keep)
    return out


def prune(dest: Path, keep: int) -> list[Path]:
    """只留最新的 keep 份（文件名里就是时间，按名字排就是按时间排）。顺手清掉没打完的 .part"""
    for p in dest.glob(f"{PREFIX}*{SUFFIX}.part"):
        p.unlink(missing_ok=True)
    old = sorted(dest.glob(f"{PREFIX}*{SUFFIX}"))[:-keep] if keep > 0 else []
    for p in old:
        p.unlink(missing_ok=True)
    return old


def nightly(store: KBStore, dest: Path, keep: int) -> None:
    """复盘循环里调的那一下。**不抛异常**：备份坏了不能连累明晚的复盘"""
    try:
        out = make(store, dest, keep=keep)
        log.info("每晚备份好了：%s（%.1f MB）", out, out.stat().st_size / 1e6)
    except Exception:  # noqa: BLE001
        log.exception("每晚备份失败（不发通知，明晚再备；旧的备份没动）：%s", dest)
