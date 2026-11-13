"""控制台登录：拿 `.env` 里的 ADMIN_PASSWORD 换一个进程内的凭证。

跟原来「转手问 6099」不同，控制台现在自己认密码：
- 密码对 -> `secrets.token_hex(32)`，记在进程内存的 dict 里，活 7 天；
- 每次带着有效 token 的请求都续期到「现在 + 7 天」，一直用就一直不过期；
- 进程重启全失效，这是预期行为（没有落盘，也没有 refresh token）。

密码留空时 `configured` 为 False，`login` 永远回 None；admin_web 的 guard 会直接回 503。
连续登错按 IP 计数：前 4 次只是 401，第 5 次起进入锁定期，锁定期内直接抛 `LoginThrottled`
（admin_web 回 429），**不 sleep、不封 IP**。锁定时长第 5 次 1 秒、每多错一次加 1 秒，最多
60 秒；登录成功清零。

注意 `scripts/lan_proxy.py` 是 TCP 层转发，只搬字节、不改 HTTP 头，所以局域网访问时
`request.remote` 全是 lan 容器那一个 IP —— 按 IP 计数在那种部署下会退化成一个全局桶。
这没法在后端区分，只能接受。
"""
from __future__ import annotations

import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

TOKEN_TTL = timedelta(days=7)
# 失败记录 / 锁定记录闲置超过这么久就删掉，避免有人拿几万个 IP 把 dict 撑大
THROTTLE_WINDOW = 3600.0
# 单次锁定的上限
MAX_LOCK = 60.0
# 从第几次连续失败开始锁
LOCK_AFTER = 5


class LoginThrottled(Exception):
    """这个 IP 还在锁定期内：调用方应该直接回 429，不要再比密码。"""

    def __init__(self, retry_after: float) -> None:
        super().__init__(f"再等 {retry_after:.1f} 秒")
        self.retry_after = retry_after


class ConsoleAuth:
    def __init__(self, password: str, *, clock: Callable[[], float] = time.time) -> None:
        self._password = password or ""
        self._clock = clock
        # token -> 过期时间（带时区的 datetime）。只放在内存里，重启即失效
        self._tokens: dict[str, datetime] = {}
        # ip -> (连续失败次数, 最后一次失败的时间戳)
        self._fails: dict[str, tuple[int, float]] = {}
        # ip -> (解锁时间戳, 最后一次拒绝的时间戳)
        self._locked: dict[str, tuple[float, float]] = {}

    @property
    def configured(self) -> bool:
        return bool(self._password)

    def _now(self) -> datetime:
        return datetime.fromtimestamp(self._clock(), tz=timezone.utc)

    def _prune(self, now: datetime) -> None:
        """清掉过期 token，以及一小时没动过的失败 / 锁定记录，别让 dict 无限涨。"""
        for token in [t for t, exp in self._tokens.items() if exp <= now]:
            del self._tokens[token]
        now_ts = now.timestamp()
        cutoff = now_ts - THROTTLE_WINDOW
        for ip, (_, seen) in list(self._fails.items()):
            if seen < cutoff:
                del self._fails[ip]
        for ip, (until, seen) in list(self._locked.items()):
            if until <= now_ts or seen < cutoff:
                del self._locked[ip]

    async def login(self, password: str, *, ip: str = "") -> tuple[str, datetime] | None:
        """密码对就发 token 和过期时间；错就回 None；锁定期内抛 `LoginThrottled`。

        整个函数没有 `await`，所以「读计数 -> 加一 -> 记解锁时间」在 asyncio 里是原子的，
        并发的错密码请求会排在同一条事件循环上依次计数，不会像以前那样各自 sleep。
        """
        if not self.configured:
            return None
        if not isinstance(password, str):
            password = ""
        now = self._now()
        self._prune(now)
        now_ts = now.timestamp()

        locked = self._locked.get(ip)
        if locked is not None and now_ts < locked[0]:
            # 锁定期内直接拒绝，不再累加失败次数；顺手记一下还活着，别被 prune 提前清掉
            self._locked[ip] = (locked[0], now_ts)
            raise LoginThrottled(locked[0] - now_ts)

        if not hmac.compare_digest(password.encode("utf-8"), self._password.encode("utf-8")):
            fails, _ = self._fails.get(ip, (0, now_ts))
            fails += 1
            self._fails[ip] = (fails, now_ts)
            if fails >= LOCK_AFTER:
                # 第 5 次锁 1 秒，之后每多错一次多 1 秒，最多 60 秒
                seconds = min(fails - (LOCK_AFTER - 1), MAX_LOCK)
                self._locked[ip] = (now_ts + seconds, now_ts)
            return None

        self._fails.pop(ip, None)
        self._locked.pop(ip, None)
        token = secrets.token_hex(32)
        expires = now + TOKEN_TTL
        self._tokens[token] = expires
        return token, expires

    def check(self, token: str) -> bool:
        """有效就续期到「现在 + 7 天」并回 True；过期/伪造回 False。"""
        if not token:
            return False
        now = self._now()
        self._prune(now)
        expires = self._tokens.get(token)
        if expires is None or expires <= now:
            self._tokens.pop(token, None)
            return False
        self._tokens[token] = now + TOKEN_TTL
        return True

    def logout(self, token: str) -> bool:
        return self._tokens.pop(token, None) is not None

    def expires_at(self, token: str) -> datetime | None:
        now = self._now()
        self._prune(now)
        expires = self._tokens.get(token)
        if expires is None or expires <= now:
            return None
        return expires
