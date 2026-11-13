"""ConsoleAuth 的单元用例：发 token、续期、过期、登出、按 IP 节流（429 之前的锁定）。"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone

from bot.console_auth import LOCK_AFTER, LoginThrottled, TOKEN_TTL, ConsoleAuth


class FakeClock:
    def __init__(self, now: float = 1_700_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class ConsoleAuthTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        # 中文密码也要能比：hmac.compare_digest 对非 ASCII 的 str 会报错，实现里统一 encode
        self.auth = ConsoleAuth("正确密码", clock=self.clock)

    async def _wrong(self, times: int, ip: str = "") -> None:
        for _ in range(times):
            self.assertIsNone(await self.auth.login("错的", ip=ip))

    async def test_login_returns_token_and_expiry(self) -> None:
        got = await self.auth.login("正确密码")
        self.assertIsNotNone(got)
        assert got is not None
        token, expires = got
        self.assertEqual(len(token), 64)
        int(token, 16)  # 是 hex
        self.assertEqual(expires, datetime.fromtimestamp(self.clock.now, tz=timezone.utc) + TOKEN_TTL)
        self.assertTrue(self.auth.check(token))

    async def test_wrong_password_returns_none(self) -> None:
        self.assertIsNone(await self.auth.login("错误密码"))
        self.assertIsNone(await self.auth.login(""))

    async def test_empty_password_is_not_configured(self) -> None:
        auth = ConsoleAuth("", clock=self.clock)
        self.assertFalse(auth.configured)
        self.assertIsNone(await auth.login(""))
        self.assertIsNone(await auth.login("随便什么"))

    async def test_forged_token_rejected(self) -> None:
        self.assertFalse(self.auth.check("f" * 64))
        self.assertFalse(self.auth.check(""))

    async def test_token_expires_after_seven_days(self) -> None:
        token, _ = await self.auth.login("正确密码")
        self.clock.advance(TOKEN_TTL.total_seconds() + 1)
        self.assertFalse(self.auth.check(token))
        self.assertIsNone(self.auth.expires_at(token))
        # 过期的顺手清掉
        self.assertNotIn(token, self.auth._tokens)

    async def test_check_renews_token(self) -> None:
        token, _ = await self.auth.login("正确密码")
        # 第 6 天用一次，续到第 13 天
        self.clock.advance(6 * 86400)
        self.assertTrue(self.auth.check(token))
        # 再过 2 天（离签发已 8 天）仍然能用
        self.clock.advance(2 * 86400)
        self.assertTrue(self.auth.check(token))
        # 离最后一次续期也过 7 天才失效
        self.clock.advance(7 * 86400 + 1)
        self.assertFalse(self.auth.check(token))

    async def test_logout_invalidates_token(self) -> None:
        token, _ = await self.auth.login("正确密码")
        self.assertTrue(self.auth.check(token))
        self.assertTrue(self.auth.logout(token))
        self.assertFalse(self.auth.check(token))
        self.assertFalse(self.auth.logout(token))

    async def test_fifth_failure_locks_for_one_second(self) -> None:
        ip = "1.2.3.4"
        # 前 5 次只是 401（login 回 None），第 5 次顺手锁 1 秒
        await self._wrong(LOCK_AFTER - 1, ip)
        self.assertIsNone(await self.auth.login("错的", ip=ip))
        # 第 6 次还在锁定期内 -> 直接抛，不再比密码
        with self.assertRaises(LoginThrottled) as ctx:
            await self.auth.login("错的", ip=ip)
        self.assertGreater(ctx.exception.retry_after, 0)
        self.assertLessEqual(ctx.exception.retry_after, 1)
        # 0.5 秒后还在锁
        self.clock.advance(0.5)
        with self.assertRaises(LoginThrottled):
            await self.auth.login("错的", ip=ip)
        # 满 1 秒放行；再错就累到第 6 次，锁 2 秒
        self.clock.advance(0.5)
        self.assertIsNone(await self.auth.login("错的", ip=ip))
        with self.assertRaises(LoginThrottled) as ctx:
            await self.auth.login("错的", ip=ip)
        self.assertGreater(ctx.exception.retry_after, 1)
        self.assertLessEqual(ctx.exception.retry_after, 2)

    async def test_lock_grows_by_one_second_each_failure(self) -> None:
        ip = "1.2.3.4"
        await self._wrong(LOCK_AFTER - 1, ip)
        durations = []
        # 每错一次前先把上一次的锁等完，记录这次锁了多久
        for _ in range(6):
            self.assertIsNone(await self.auth.login("错的", ip=ip))
            until, _ = self.auth._locked[ip]
            durations.append(until - self.clock.now)
            self.clock.advance(until - self.clock.now)
        self.assertEqual(durations, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0])

    async def test_lock_caps_at_sixty_seconds(self) -> None:
        ip = "1.2.3.4"
        await self._wrong(LOCK_AFTER - 1, ip)
        for _ in range(80):
            self.assertIsNone(await self.auth.login("错的", ip=ip))
            self.clock.advance(self.auth._locked[ip][0] - self.clock.now)
        self.assertIsNone(await self.auth.login("错的", ip=ip))
        until, _ = self.auth._locked[ip]
        self.assertEqual(until - self.clock.now, 60.0)

    async def test_success_clears_failure_count_and_lock(self) -> None:
        ip = "1.2.3.4"
        await self._wrong(LOCK_AFTER - 1, ip)
        self.assertIsNotNone(await self.auth.login("正确密码", ip=ip))
        self.assertNotIn(ip, self.auth._fails)
        self.assertNotIn(ip, self.auth._locked)
        # 清零后又能错 5 次才锁
        await self._wrong(LOCK_AFTER - 1, ip)
        self.assertIsNone(await self.auth.login("错的", ip=ip))
        with self.assertRaises(LoginThrottled):
            await self.auth.login("错的", ip=ip)

    async def test_failures_are_counted_per_ip(self) -> None:
        await self._wrong(LOCK_AFTER - 1, "1.2.3.4")
        await self._wrong(LOCK_AFTER - 1, "5.6.7.8")
        self.assertIsNone(await self.auth.login("错的", ip="1.2.3.4"))
        with self.assertRaises(LoginThrottled):
            await self.auth.login("错的", ip="1.2.3.4")
        # 另一个 IP 不受影响：它还只错了 4 次
        self.assertIsNone(await self.auth.login("错的", ip="5.6.7.8"))

    async def test_stale_failure_records_are_pruned(self) -> None:
        # 5000 个不同 IP 各错一次，不能永久常驻
        for i in range(5000):
            await self.auth.login("错的", ip=f"10.0.{i // 256}.{i % 256}")
        self.assertEqual(len(self.auth._fails), 5000)
        # 一小时后（多 1 秒）再来一次鉴权，顺手把旧的失败记录清掉
        self.clock.advance(3601)
        self.assertFalse(self.auth.check("f" * 64))
        self.assertEqual(self.auth._fails, {})
        self.assertEqual(self.auth._locked, {})

    async def test_stale_but_still_locked_ip_is_kept(self) -> None:
        # 锁还没到期的记录不能被「闲置一小时」误删（虽然锁最长 60 秒，这里测 prune 顺序）
        ip = "1.2.3.4"
        await self._wrong(LOCK_AFTER, ip)
        self.clock.advance(0.5)
        self.assertFalse(self.auth.check("f" * 64))
        self.assertIn(ip, self.auth._locked)
        with self.assertRaises(LoginThrottled):
            await self.auth.login("错的", ip=ip)
