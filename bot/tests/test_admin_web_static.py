"""admin_web 的登录、静态托管和现有接口回归用例。"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from aiohttp.test_utils import TestClient, TestServer

from bot.admin_web import AdminApp
from bot.console_auth import TOKEN_TTL, ConsoleAuth


class FakeEntry:
    id = 7
    question = "怎么退款"
    aliases = "退款\n退钱"
    answer = "找客服处理"
    hits = 3
    updated_at = "2026-01-01 00:00:00"
    source = "web"


class FakeStore:
    def __init__(self) -> None:
        self.stats_calls = 0

    def stats(self) -> tuple[int, int, int, str]:
        self.stats_calls += 1
        return 1, 2, 1, "资料 1 份 / 2 块，标准答案 1 条"

    def stats_line(self) -> str:
        return "资料 1 份 / 2 块，标准答案 1 条"

    def docs(self) -> list[object]:
        return [object()]

    def chunk_count(self) -> int:
        return 2

    def entry_count(self) -> int:
        return 1

    def entries(self) -> list[FakeEntry]:
        return [FakeEntry()]

    def all_entry_images(self) -> dict[int, list[tuple[int, str]]]:
        return {}

    def trusted_list(self) -> list[dict[str, object]]:
        return [{"user_id": 10001, "note": "老客户", "created_at": "2026-01-01"}]


class FakeApprovalStore:
    def banned(self) -> list[dict[str, object]]:
        return [{"user_id": 10002, "note": "广告", "created_at": "2026-01-01"}]


class FakeClock:
    def __init__(self, now: float = 1_700_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_settings(password: str = "secret") -> SimpleNamespace:
    return SimpleNamespace(
        admin_password=password,
        lan_hosts=frozenset(),
        webui_public_url="",
        webui_url="http://127.0.0.1:6099",
        crawl_vision_model="qwen3.8-flash",
        kb_hit_score=0.78,
        super_admins=frozenset({10000}),
        trusted=frozenset({10000}),
        report_group=0,
    )


class AdminWebTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dist = Path(self.tmp.name)
        (self.dist / "assets").mkdir()
        (self.dist / "index.html").write_text("<html>控制台首页</html>", encoding="utf-8")
        (self.dist / "assets" / "x.js").write_text("console.log('x')", encoding="utf-8")

        self.auth = ConsoleAuth("secret")
        self.store = FakeStore()
        self.admin = AdminApp(
            make_settings(), self.store, object(), auth=self.auth,
            approval_store=FakeApprovalStore(), console_dist=self.dist,
        )
        self.client = TestClient(TestServer(self.admin.build()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.token, _ = await self.auth.login("secret", ip="127.0.0.1")

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    async def _new_client(self, settings: SimpleNamespace, auth: ConsoleAuth | None = None) -> TestClient:
        admin = AdminApp(
            settings, FakeStore(), object(), auth=auth,
            approval_store=FakeApprovalStore(), console_dist=self.dist,
        )
        client = TestClient(TestServer(admin.build()))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client

    # ---- 静态文件 ----

    async def test_root_serves_index(self) -> None:
        resp = await self.client.get("/")
        self.assertEqual(resp.status, 200)
        self.assertIn("控制台首页", await resp.text())

    async def test_unknown_path_falls_back_to_index(self) -> None:
        resp = await self.client.get("/kb/entries")
        self.assertEqual(resp.status, 200)
        self.assertIn("控制台首页", await resp.text())

    async def test_existing_asset_is_served(self) -> None:
        resp = await self.client.get("/assets/x.js")
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.text(), "console.log('x')")

    async def test_non_get_methods_are_405(self) -> None:
        for method, path in [("post", "/"), ("delete", "/assets/x.js")]:
            resp = await getattr(self.client, method)(path)
            self.assertEqual(resp.status, 405)
            self.assertNotIn("控制台首页", await resp.text())

    async def test_api_like_static_paths_are_404_not_index(self) -> None:
        # /API/stats 大小写不对、//api/stats 多一个斜杠，都不能掉到 SPA 兜底发 index.html
        resp = await self.client.get("/API/stats")
        self.assertEqual(resp.status, 404)
        self.assertNotIn("控制台首页", await resp.text())
        # 双斜杠要绕过 TestClient 的 URL 规范化，直接用 session 发绝对地址
        base = str(self.client.make_url("/")).rstrip("/")
        async with self.client.session.get(base + "//api/stats") as resp:
            self.assertEqual(resp.status, 404)
            self.assertNotIn("控制台首页", await resp.text())

    async def test_path_traversal_is_blocked(self) -> None:
        # 用 %2f 才不会被客户端先把 .. 规范化掉，服务端看到的才是穿越路径
        resp = await self.client.get("/..%2f..%2fetc/passwd")
        self.assertIn(resp.status, (403, 404))
        body = await resp.text()
        self.assertNotIn("root:", body)
        self.assertNotIn("控制台首页", body)

    async def test_missing_dist_returns_404_with_hint(self) -> None:
        self.admin.console_dist = self.dist / "not-built"
        resp = await self.client.get("/")
        self.assertEqual(resp.status, 404)
        self.assertIn("pnpm build", await resp.text())

    async def test_static_paths_also_check_host(self) -> None:
        resp = await self.client.get("/", headers={"Host": "evil.example.com"})
        self.assertEqual(resp.status, 403)

    # ---- 登录 / token ----

    async def test_login_ok(self) -> None:
        resp = await self.client.post("/api/console/login", json={"password": "secret"})
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertEqual(len(body["token"]), 64)
        self.assertIn("expires_at", body)

    async def test_login_wrong_password_401(self) -> None:
        resp = await self.client.post("/api/console/login", json={"password": "错的"})
        self.assertEqual(resp.status, 401)
        self.assertEqual(await resp.json(), {"error": "密码不对"})

    async def test_login_has_no_token_requirement(self) -> None:
        resp = await self.client.post("/api/console/login", json={"password": "secret"})
        self.assertEqual(resp.status, 200)

    async def test_no_password_configured_503(self) -> None:
        client = await self._new_client(make_settings(""))
        for method, path in [("get", "/api/stats"), ("post", "/api/console/login")]:
            resp = await getattr(client, method)(path, json={"password": ""} if method == "post" else None)
            self.assertEqual(resp.status, 503)
            self.assertEqual(await resp.json(), {
                "error": "没配 ADMIN_PASSWORD，控制台用不了",
                "code": "no-password",
            })

    async def test_no_password_options_preflight_is_503(self) -> None:
        client = await self._new_client(make_settings(""))
        resp = await client.options("/api/stats", headers={"Origin": "http://127.0.0.1:6099"})
        self.assertEqual(resp.status, 503)
        self.assertEqual((await resp.json())["code"], "no-password")

    async def test_other_503_has_no_code(self) -> None:
        # 没连 QQ 的 503 不能带 no-password，前端靠 code 区分
        resp = await self.client.get("/api/groups", headers=self._auth())
        self.assertEqual(resp.status, 503)
        body = await resp.json()
        self.assertEqual(body, {"error": "这个接口没连 QQ"})
        self.assertNotIn("code", body)

    async def test_bad_charset_login_is_400_with_cors(self) -> None:
        origin = "http://127.0.0.1:6099"
        resp = await self.client.post(
            "/api/console/login",
            data=b'{"password":"secret"}',
            headers={"Content-Type": "application/json; charset=nope", "Origin": origin},
        )
        self.assertEqual(resp.status, 400)
        self.assertEqual(await resp.json(), {"error": "请求格式不对"})
        self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), origin)

    async def test_unhandled_error_is_500_with_cors(self) -> None:
        # guard 的兜底：handler 没接住的异常也要带 CORS，不能变成没有头的裸 500
        origin = "http://127.0.0.1:6099"
        resp = await self.client.post(
            "/api/trusted",
            data=b"{}",
            headers={
                **self._auth(),
                "Content-Type": "application/json; charset=nope",
                "Origin": origin,
            },
        )
        self.assertEqual(resp.status, 500)
        self.assertEqual(await resp.json(), {"error": "后端出错了，看日志"})
        self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), origin)

    async def test_me_ok(self) -> None:
        resp = await self.client.get("/api/console/me", headers=self._auth())
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertTrue(body["ok"])
        self.assertIn("expires_at", body)

    async def test_missing_or_forged_token_401(self) -> None:
        for headers in ({}, {"Authorization": "Bearer " + "f" * 64}):
            resp = await self.client.get("/api/stats", headers=headers)
            self.assertEqual(resp.status, 401)
            self.assertEqual(await resp.json(), {"error": "没登录或登录过期了"})

    async def test_me_and_logout_without_token_401(self) -> None:
        resp = await self.client.get("/api/console/me")
        self.assertEqual(resp.status, 401)
        self.assertEqual(await resp.json(), {"error": "没登录或登录过期了"})
        resp = await self.client.post("/api/console/logout")
        self.assertEqual(resp.status, 401)
        self.assertEqual(await resp.json(), {"error": "没登录或登录过期了"})

    async def test_login_throttled_429_until_lock_expires(self) -> None:
        clock = FakeClock()
        auth = ConsoleAuth("secret", clock=clock)
        client = await self._new_client(make_settings(), auth=auth)

        # 前 5 次错密码还是 401（第 5 次顺手锁 1 秒）
        for _ in range(5):
            resp = await client.post("/api/console/login", json={"password": "错的"})
            self.assertEqual(resp.status, 401)
        # 第 6 次进锁定期 -> 429，且不再 sleep 占连接
        resp = await client.post("/api/console/login", json={"password": "错的"})
        self.assertEqual(resp.status, 429)
        self.assertEqual(await resp.json(), {"error": "试太多次了，等一会儿"})
        # 锁定期内再试还是 429
        resp = await client.post("/api/console/login", json={"password": "错的"})
        self.assertEqual(resp.status, 429)
        # 假时钟推过 1 秒，放行；这次错会累到第 6 次，锁 2 秒
        clock.advance(1)
        resp = await client.post("/api/console/login", json={"password": "错的"})
        self.assertEqual(resp.status, 401)
        resp = await client.post("/api/console/login", json={"password": "错的"})
        self.assertEqual(resp.status, 429)
        # 再推 2 秒，登录成功 -> 200，并且失败计数清零
        clock.advance(2)
        resp = await client.post("/api/console/login", json={"password": "secret"})
        self.assertEqual(resp.status, 200)
        self.assertNotIn("127.0.0.1", auth._fails)
        self.assertNotIn("127.0.0.1", auth._locked)
        # 清零后又要连错 5 次才锁
        for _ in range(5):
            resp = await client.post("/api/console/login", json={"password": "错的"})
            self.assertEqual(resp.status, 401)
        resp = await client.post("/api/console/login", json={"password": "错的"})
        self.assertEqual(resp.status, 429)

    async def test_expired_token_401(self) -> None:
        clock = FakeClock()
        auth = ConsoleAuth("secret", clock=clock)
        client = await self._new_client(make_settings(), auth=auth)
        token, _ = await auth.login("secret", ip="127.0.0.1")
        clock.advance(TOKEN_TTL.total_seconds() + 1)
        resp = await client.get("/api/stats", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(resp.status, 401)

    async def test_logout_invalidates_token(self) -> None:
        token, _ = await self.auth.login("secret", ip="127.0.0.1")
        headers = {"Authorization": f"Bearer {token}"}
        self.assertEqual((await self.client.get("/api/console/me", headers=headers)).status, 200)
        resp = await self.client.post("/api/console/logout", headers=headers)
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"ok": True})
        self.assertEqual((await self.client.get("/api/console/me", headers=headers)).status, 401)

    # ---- 现有接口回归 ----

    async def test_stats_keeps_line_and_adds_counts(self) -> None:
        resp = await self.client.get("/api/stats", headers=self._auth())
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertEqual(body["line"], "资料 1 份 / 2 块，标准答案 1 条")
        self.assertEqual(body["docs"], 1)
        self.assertEqual(body["chunks"], 2)
        self.assertEqual(body["entries"], 1)
        for key in ("docs", "chunks", "entries"):
            self.assertIsInstance(body[key], int)
        # handler 只调一次 store.stats()，不再 stats_line + 三个 count 各查一遍
        self.assertEqual(self.store.stats_calls, 1)

    async def test_entries_shape_unchanged(self) -> None:
        resp = await self.client.get("/api/entries", headers=self._auth())
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertIsInstance(body, list)
        self.assertEqual(body[0]["id"], 7)
        self.assertEqual(body[0]["question"], "怎么退款")
        self.assertEqual(body[0]["aliases"], ["退款", "退钱"])
        self.assertEqual(body[0]["answer"], "找客服处理")
        self.assertEqual(body[0]["images"], [])

    async def test_trusted_shape_unchanged(self) -> None:
        resp = await self.client.get("/api/trusted", headers=self._auth())
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertIn("fixed", body)
        self.assertIn("list", body)
        self.assertEqual(body["list"][0]["user_id"], 10001)
        self.assertEqual(body["fixed"][0]["user_id"], 10000)

    async def test_banned_shape_unchanged(self) -> None:
        resp = await self.client.get("/api/banned", headers=self._auth())
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertEqual(body["list"][0]["user_id"], 10002)
