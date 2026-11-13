"""QQ 登录态健康信号。

NapCat 掉登录时，WebSocket 可能还通着（心跳照来），从连接层根本看不出来。
但 QQ 会明确推一条 notice.bot_offline 事件——这是最准的信号，别浪费。

为什么落成文件而不是内存状态：守护进程（scripts/napcat_guard.py）在宿主机、
另一个进程里，它得能读到。

---

**这个文件在磁盘上长这样**（`data/health/qq_offline.json`）：

    {"ts": 1794218744.12, "reason": "你的账号当前登录已失效，请重新登录。"}

`ts` 是 unix 秒（float）。守护进程拿「现在 - ts」跟 `GUARD_OFFLINE_MARKER_TTL`
（默认 600 秒）比：在这个窗口里就当「现在还是掉线的」。

**为什么挂文件是安全的**：`docker-compose.yml` 把 `./data` 整个挂进 bot 容器
（`/app/data`），所以容器里 `/app/data/health/qq_offline.json` 和宿主机
`~/qq客户ai助手/data/health/qq_offline.json` 是**同一个 inode**。容器里 bot 以
uid 502 写、宿主机也是 502，权限没问题（`data/` 现成的目录就是这个 uid）。

**为什么用 unix 秒而不是「第几次掉线」这类自增标记**：守护进程和 bot 是两个进程、
两套时钟。存绝对时刻，守护进程自己的时钟说了算——它不需要跟 bot 对齐任何东西，
也不怕守护进程重启。掉线期间 bot 不会去改这个文件（它要收到正常消息才删），
所以 ts 就是「掉线那一刻」，年龄才有意义。

---

**注意两条容易踩的**：

1. `data/health/` 不存在要自己建（`mkdir -p` 语义）。这个目录**不在** git 里，
   新机器上第一次掉线才出现。
2. `mark_online()` 会被「每一条进来的消息」调用，所以它必须**极其便宜**：
   不存在就直接返回，不要先 stat 再判断再抛异常玩。现在是一次 `unlink` + 接住
   `FileNotFoundError`，够用。**不要**在这里加重试、加锁、加 fsync。
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

# 项目根目录（容器里是 /app）。故意不 import .config 的 ROOT：
# 那边一上来就 `from dotenv import load_dotenv`，而这份模块要能单独跑、
# 也让 tests/test_health.py 不必把 .env 摆好才能 import。
ROOT = Path(__file__).resolve().parent.parent

HEALTH_DIR = ROOT / "data" / "health"
# 文件名别改：守护进程（scripts/napcat_guard.py 的 GUARD_STATE_FILE 旁边那个）也在读它
OFFLINE_FILE = HEALTH_DIR / "qq_offline.json"

log = logging.getLogger(__name__)


def mark_offline(reason: str, *, now: float | None = None, path: Path | None = None) -> None:
    """记下「QQ 掉登录了」。原子写，写不进去只记日志、不抛。

    调用时机：收到 `notice.bot_offline`（见 `bot/handlers/health.py`）。
    `path` 和 `now` 是给用例用的，生产代码不要传——生产传了就说明路径/时钟有两套，
    宿主机上的守护进程会读不到。

    `path` 的默认值写成 `None` 再在函数里取 `OFFLINE_FILE`，**不是多此一举**：
    写成 `path: Path = OFFLINE_FILE` 的话默认值在 import 时就绑死了，用例里
    改 `health.OFFLINE_FILE` 根本不起作用，只能去真 `data/` 里写文件。
    """
    path = OFFLINE_FILE if path is None else Path(path)
    ts = time.time() if now is None else float(now)
    # 文案为空时给个兜底：这个文件是人出故障时第一眼看的东西，
    # 空字符串会让「为什么掉了」这个问题无从查起
    reason = (reason or "").strip() or "NapCat 报了 bot_offline，但没带原因"
    payload = {"ts": ts, "reason": reason}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # 先写 .tmp 再 os.replace：机器要是正好在这一下断电/被杀，
        # 读到的是「上一个完整文件」或者「新的完整文件」，不会是半截 JSON
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        # 磁盘满、data/ 只读之类。**不能抛**：写不了标记不该让读循环跟着挂
        log.warning("掉线标记写不进去（%s）：%s", path, e)
        return
    log.error("QQ 掉登录了，已记下标记（宿主机守护进程会看到）：%s", reason)


def mark_online(*, path: Path | None = None) -> None:
    """「QQ 好了」——删掉标记。文件本来就不在的时候什么都不做，也不报错。

    调用时机：收到任何正常群消息 / 私聊消息，或者心跳里 `status.online` 为真
    （设计规格第六节的三条接线）。
    """
    path = OFFLINE_FILE if path is None else Path(path)
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as e:
        # 删不掉（权限、只读挂载）比写不进去更常见，而且**更该说一声**：
        # 文件还在，守护进程就会一直以为在掉线，可能白重启 NapCat 两次
        log.warning("掉线标记删不掉（%s）：%s", path, e)
        return
    log.info("QQ 登录态正常了，删掉掉线标记 %s", path)


def offline_age(path: Path | None = None, now: float | None = None) -> float | None:
    """标记多少秒之前写的。文件不存在 / JSON 坏了 / 没有 ts → None（= 没在掉线）。

    坏文件当 None 是故意的：宁可漏一次「假在线」，也不要让一个半截文件让所有人
    以为机器永远掉线。
    """
    ts = _read_ts(OFFLINE_FILE if path is None else Path(path))
    if ts is None:
        return None
    return (time.time() if now is None else float(now)) - ts


def _read_ts(path: Path) -> float | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        log.warning("掉线标记不是合法 JSON，当它不存在：%s", path)
        return None
    if not isinstance(data, dict):
        return None
    ts = data.get("ts")
    # bool 是 int 的子类，得单独挡掉：{"ts": true} 不是时间戳
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return None
    return float(ts)
