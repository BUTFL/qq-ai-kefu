"""拿 6099 登录后发的凭证问 NapCat「这人登录了没」。知识库接口（admin_web.py）靠它鉴权。

6099 登录成功后，前端把 NapCat 发的 Credential 存在 localStorage，请求时放 `Authorization: Bearer`。
标准答案 / 资料库两页也带同一个头来调我们，我们转手 POST NapCat 的 `/api/auth/check` 验一下 ——
凭证是 NapCat 进程里的随机密钥签的，本地验不了，只能问它。好处是只有一套登录：
6099 登上了两页就能用，6099 过期（一小时）或 NapCat 重启了，两页跟着失效。

验过的凭证记 60 秒，不然一页十几张配图就是十几次往返。
"""
from __future__ import annotations

import logging
import time
from typing import Callable

import httpx

log = logging.getLogger(__name__)

TTL = 60.0


class NapCatDown(Exception):
    """连不上 NapCat，判断不了凭证真假。跟「凭证不对」分开，页面上提示不一样。"""


class NapCatAuth:
    def __init__(self, base_url: str, *, clock: Callable[[], float] = time.monotonic) -> None:
        # trust_env=False：本机开着系统代理时，httpx 会把 127.0.0.1 也发给代理，
        # NapCat 没起的时候代理回 502 而不是连接失败。只连本机，用不着代理
        self._client = httpx.AsyncClient(base_url=base_url.rstrip("/") + "/api", timeout=5.0, trust_env=False)
        self._clock = clock
        self._ok: dict[str, float] = {}

    async def close(self) -> None:
        await self._client.aclose()

    async def check(self, credential: str) -> bool:
        if not credential:
            return False
        now = self._clock()
        if self._ok.get(credential, 0.0) > now:
            return True
        try:
            resp = await self._client.post("/auth/check", headers={"Authorization": f"Bearer {credential}"})
        except httpx.HTTPError as e:
            raise NapCatDown(f"连不上 NapCat（{e.__class__.__name__}）") from e
        if resp.status_code >= 500:
            raise NapCatDown(f"NapCat 回了 HTTP {resp.status_code}")
        try:
            ok = resp.json().get("code") == 0
        except ValueError:
            raise NapCatDown("NapCat 回的不是 JSON") from None
        if ok:
            if len(self._ok) > 256:
                self._ok = {k: v for k, v in self._ok.items() if v > now}
            self._ok[credential] = now + TTL
        return ok
