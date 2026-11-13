"""实时画面：连上之后一直拉客户屏幕，AI 操作员每一步拿到的都是**当下这一帧**。

为什么不再「每步截一张图」：

- 老路子是 `动作 → 固定等 600ms → 截图 → 想`。等短了界面还没变完，等长了白白浪费；
  模型也不知道上一下到底点没点中，只能靠下一张图猜。
- 向日葵的 MCP **没有视频流接口**（2026-10-16 把 31 个工具全列了一遍，看画面的只有
  `control_screenshot`）。但它一帧只要 ~190ms（审计里 745 次截图：中位 191ms、p90 211ms），
  后台连续拉就是一路 3~5 帧/秒的实时画面。

这一层只做三件事：

1. **后台一直拉帧**（`interval` 秒一帧），只留最新那帧在内存里；
2. `fresh()`：给模型取「足够新」的那一帧，等不到就抛错 —— **宁可停手，也不拿旧画面去点**；
3. `wait_settled()`：动作做完之后**看着画面等它变完**，而不是死等 600ms，
   顺带告诉模型「上一步之后画面变没变」，点空了它下一步就知道。

**不落盘、不逐帧审计**：一秒几帧写审计会把 `remote_audit.jsonl` 撑爆，只在开始/结束各记一条
（拉了多少帧、出错几次）。拉帧走 `RemoteOperator.frame()`：白名单、会话结束、时长上限照样管，
只是不占「一单最多几次操作」的名额 —— 看画面不是在动客户的电脑。

### 「变没变」怎么判（真机量出来的，别改回按字节比）

**不能按字节/摘要比**：2026-10-16 在验证机 399999003 上对着**完全静止的桌面**连拉 8 帧，
相邻两帧有 **97%~99% 的字节不一样**（向日葵每帧都重新编码一次，有损噪声铺满全图），
按摘要比永远是「变了」——「画面没变化」的提示一次都不会出，等稳定也永远等到超时。

但**JPEG 的大小几乎不抖**：同一组 8 帧在 135 737~135 879 字节之间，相邻差 5~66 字节（≈0.05%）。
项目刻意不引 PIL/numpy，所以按**大小**判：

- 噪声 = 最近几帧相邻大小差的中位数（不低于 `NOISE_FLOOR`），每次动作前现量，不写死；
- 差得多（> `max(4×噪声, CHANGE_MIN)`）→ **变了**；
- 差得很少（≤ `max(2×噪声, SAME_MAX)`）→ **没变**；
- 夹在中间 → **说不准**（`None`）。说不准就不给模型下结论 —— 把「点中了」说成「没生效」，
  模型会去换做法，比不提示更糟。

**没量过的**：真实界面变化（弹菜单、打一个字）让大小差多少，那次没量成（验证机要人点同意才能再连）。
阈值是按静止噪声定的，「打一个字」这种小变化很可能落进「说不准」—— 这是故意保守。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

from .assist import shot_bytes

log = logging.getLogger(__name__)

# 判「变没变」的门槛（字节）。依据见模块说明：静止桌面相邻帧大小差 5~66 字节
NOISE_FLOOR = 40      # 噪声至少按这么多算（帧太少时别把噪声估成 0）
SAME_MAX = 120        # 差这么少以内 → 没变
CHANGE_MIN = 400      # 差这么多以上 → 变了


@dataclass(frozen=True)
class Frame:
    """一帧画面。`seq` 每来一帧加一；`digest` 相同 = 画面字节一模一样。"""

    data: bytes
    width: Any
    height: Any
    seq: int
    ts: float
    digest: str

    @property
    def age(self) -> float:
        return time.time() - self.ts

    @property
    def size(self) -> int:
        return len(self.data)


class LiveScreen:
    """一路实时画面。

        screen = LiveScreen(op, session)
        await screen.start()
        f = await screen.fresh()                   # 拿当下这一帧去问模型
        ...做动作...
        f2, changed = await screen.wait_settled(f) # 等画面变完，顺便知道变没变
        await screen.stop()
    """

    def __init__(self, operator: Any, session: Any, *, interval: float = 0.25,
                 max_errors: int = 8) -> None:
        self.op = operator
        self.session = session
        self.interval = max(0.05, float(interval))
        self.max_errors = max_errors
        self._frame: Frame | None = None
        self._cond = asyncio.Condition()
        self._task: asyncio.Task[None] | None = None
        self._seq = 0
        self._errors = 0           # 连续出错次数，拉到一帧就清零
        self.total_errors = 0
        self.last_error = ""
        self.started_at = 0.0
        self._sizes: deque[int] = deque(maxlen=12)   # 最近几帧的大小，估噪声用

    # ---------- 生命周期 ----------

    async def start(self) -> None:
        if self._task is not None:
            return
        self.started_at = time.time()
        self._task = asyncio.create_task(self._loop(), name="remote-live")
        _note(self.op, {"action": "live_start", "target": getattr(self.session, "target", ""),
                        "interval": self.interval})

    async def stop(self) -> None:
        t, self._task = self._task, None
        if t is None:
            return
        t.cancel()
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
        secs = time.time() - self.started_at
        _note(self.op, {"action": "live_stop", "target": getattr(self.session, "target", ""),
                        "frames": self._seq, "errors": self.total_errors,
                        "fps": round(self._seq / secs, 1) if secs > 0 else 0})
        async with self._cond:          # 叫醒还在等帧的人，让他们看到「停了」
            self._cond.notify_all()

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def broken(self) -> bool:
        """连续出错太多次，这一路画面不能信了（调用方该停手）。"""
        return self._errors >= self.max_errors

    @property
    def frames(self) -> int:
        return self._seq

    def latest(self) -> Frame | None:
        return self._frame

    def noise(self) -> float:
        """静止时相邻两帧大小差多少。帧不够就按 NOISE_FLOOR。

        取**下四分位**，不取中位数：最近几帧里只要混进一次真变化（差几千字节），
        帧少的时候中位数就被它拽上去，把那次真变化本身判成「没变」——
        用例里真踩到过（3 帧里一次变化，噪声被估成 3000 字节）。真变化是少数，下四分位不受它影响。
        """
        s = list(self._sizes)
        if len(s) < 3:
            return float(NOISE_FLOOR)
        diffs = sorted(abs(a - b) for a, b in zip(s, s[1:]))
        return max(float(NOISE_FLOOR), float(diffs[len(diffs) // 4]))

    def compare(self, a: Frame | None, b: Frame | None, noise: float | None = None) -> bool | None:
        """两帧比：True 变了 / False 没变 / None 说不准。"""
        if a is None or b is None:
            return None
        if a.digest == b.digest:
            return False
        nz = self.noise() if noise is None else noise
        d = abs(a.size - b.size)
        if d > max(4 * nz, CHANGE_MIN):
            return True
        if d <= max(2 * nz, SAME_MAX):
            return False
        return None

    # ---------- 取帧 ----------

    async def fresh(self, *, max_age: float = 0.8, timeout: float = 5.0) -> Frame:
        """取一帧**不超过 max_age 秒**的画面。等不到就抛错。"""
        deadline = time.time() + timeout
        async with self._cond:
            while True:
                self._check_alive()       # 先查：画面坏了/会话关了，缓存里那帧再新也不能用
                f = self._frame
                if f is not None and f.age <= max_age:
                    return f
                left = deadline - time.time()
                if left <= 0:
                    raise RuntimeError(f"实时画面 {timeout:.0f} 秒没来新帧"
                                       + (f"（{self.last_error}）" if self.last_error else ""))
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=min(left, 0.5))
                except asyncio.TimeoutError:
                    pass

    async def wait_settled(self, before: Frame | None, *, react: float = 1.2, quiet: float = 0.5,
                           timeout: float = 3.0) -> tuple[Frame | None, bool | None]:
        """动作做完后等画面稳定。返回 `(稳定后那一帧, 跟 before 比：True 变了 / False 没变 / None 说不准)`。

        两段：先等它**开始变**（最多 `react` 秒，界面没反应就别干等）；变了之后
        再等它**不再变**（连续 `quiet` 秒相邻帧都在噪声以内）。整体不超过 `timeout`。
        噪声在动作**之前**量好定住：动作之后的帧有真变化，混进去会把门槛抬高。
        """
        start = time.time()
        nz = self.noise()
        seen = self._frame.seq if self._frame is not None else 0
        changed = False
        prev: Frame | None = None
        last_move = start
        async with self._cond:
            while True:
                now = time.time()
                f = self._frame
                if f is not None and f.seq > seen:
                    seen = f.seq
                    if self.compare(before, f, nz) is True:
                        changed = True
                    if prev is None or self.compare(prev, f, nz) is not False:
                        last_move = now
                    prev = f
                if changed and now - last_move >= quiet:
                    break
                if not changed and now - start >= react:
                    break
                if now - start >= timeout or not self.running:
                    break
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=0.1)
                except asyncio.TimeoutError:
                    pass
        last = self._frame
        return last, (True if changed else self.compare(before, last, nz))

    # ---------- 内部 ----------

    def _check_alive(self) -> None:
        if getattr(self.session, "ended", False):
            raise RuntimeError("会话已经结束，没有画面了")
        if self.broken:
            raise RuntimeError(f"实时画面连续 {self._errors} 次没拉到（{self.last_error}）")
        if not self.running:
            raise RuntimeError("实时画面没在跑")

    async def _loop(self) -> None:
        while not getattr(self.session, "ended", False):
            t0 = time.time()
            try:
                shot = await self.op.frame(self.session)
                data = shot_bytes(shot)
                if not data:
                    raise RuntimeError("回包里没有图")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._errors += 1
                self.total_errors += 1
                self.last_error = f"{type(e).__name__}: {str(e)[:120]}"
                if self._errors in (1, self.max_errors):
                    log.warning("实时画面拉帧失败（连续 %s 次）：%s", self._errors, self.last_error)
                async with self._cond:
                    self._cond.notify_all()
                if self.broken:
                    return              # 坏透了就别再打远控，fresh() 会把原因抛给上层
                await asyncio.sleep(min(2.0, 0.3 * self._errors))
                continue
            self._errors = 0
            self._seq += 1
            frame = Frame(data=data, width=shot.get("image_width"), height=shot.get("image_height"),
                          seq=self._seq, ts=time.time(),
                          digest=hashlib.blake2b(data, digest_size=12).hexdigest())
            async with self._cond:
                self._frame = frame
                self._sizes.append(frame.size)
                self._cond.notify_all()
            await asyncio.sleep(max(0.0, self.interval - (time.time() - t0)))
        async with self._cond:
            self._cond.notify_all()


def _note(op: Any, rec: dict[str, Any]) -> None:
    """往审计里记一条（只记开始/结束，不逐帧记）。假 operator 没有这个方法就算了。"""
    fn = getattr(op, "note", None)
    if fn is None:
        return
    try:
        fn(rec)
    except Exception as e:
        log.debug("实时画面审计没记上：%s", e)
