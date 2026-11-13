"""阶段 3 前置核查：实测机器人在目标群里到底有什么权限。

依次调这些只读接口（互不影响，单个失败不拦截后面的）：
  1. get_login_info         -> 机器人自己的 QQ 号、昵称
  2. get_group_info         -> 群名、当前人数、人数上限
  3. get_group_member_info  -> 机器人自己在群里的 role（owner/admin/member）
  4. get_group_system_msg   -> 能不能拉到未处理的入群申请列表；
                                OneBot 11 标准里没有这个动作，是 NapCat 扩展，
                                报错（比如 1404 未知动作）是正常结果，不当失败处理。

跑完直接断开退出，不常驻、不改任何群状态。
用法: uv run scripts/check_group_role.py [群号，默认取 .env 里 ENABLED_GROUPS 的第一个]
退出码: 0 核查流程走完（不代表机器人权限够用，看打印的结论）/ 1 连不上或配置缺失
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot.config import ConfigError, Settings
from bot.onebot import ApiError, AuthError, OneBotClient

sys.stdout.reconfigure(line_buffering=True)  # 后台跑时也要能实时看到输出


async def _noop_on_event(_event: dict) -> None:
    """这次只主动调接口，不关心服务端推的事件，占个位置满足 OneBotClient 的签名要求。"""


async def _wait_ready(client: OneBotClient, runner: "asyncio.Task[None]", timeout: float = 15.0) -> None:
    """等到握手完成（client.connected），或者 run() 提前结束（多半是令牌被拒）。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if client.connected:
            return
        if runner.done():
            runner.result()  # 有异常就在这里抛出真实原因（比如 AuthError）
            raise RuntimeError("客户端提前退出，原因未知")
        await asyncio.sleep(0.05)
    raise TimeoutError(f"{timeout:.0f} 秒内没连上 NapCat（ws://127.0.0.1:3001 是否可达？）")


ROLE_CN = {"owner": "群主", "admin": "管理员", "member": "普通成员"}


async def main() -> int:
    try:
        settings = Settings.load()
    except ConfigError as e:
        print(f"配置错误: {e}")
        return 1

    if len(sys.argv) > 1:
        group_id = int(sys.argv[1])
    elif settings.enabled_groups:
        group_id = sorted(settings.enabled_groups)[0]
    else:
        print("错误：没传群号，且 .env 里 ENABLED_GROUPS 也是空的")
        return 1

    client = OneBotClient(settings.onebot_url, settings.onebot_token, _noop_on_event)
    runner = asyncio.create_task(client.run(), name="onebot-client")
    try:
        await _wait_ready(client, runner)
    except (AuthError, RuntimeError, TimeoutError) as e:
        print(f"错误：连不上 NapCat -> {e}")
        return 1

    try:
        # ---- 1. 机器人自己的账号 ----
        try:
            me = await client.call_api("get_login_info")
            self_id = int(me["user_id"])
            print(f"[1] get_login_info OK -> QQ号={self_id} 昵称={me.get('nickname')!r}")
        except ApiError as e:
            print(f"[1] get_login_info 失败 -> retcode={e.retcode} {e.wording or e.message}")
            self_id = None

        # ---- 2. 群基本信息 ----
        try:
            g = await client.call_api("get_group_info", group_id=group_id)
            print(
                f"[2] get_group_info OK -> 群号={group_id} 群名={g.get('group_name')!r} "
                f"人数={g.get('member_count')}/{g.get('max_member_count')}"
            )
        except ApiError as e:
            print(f"[2] get_group_info 失败 -> retcode={e.retcode} {e.wording or e.message}")

        # ---- 3. 机器人自己在群里的角色，这是本次核查的核心结论 ----
        role: str | None = None
        if self_id is not None:
            try:
                m = await client.call_api("get_group_member_info", group_id=group_id, user_id=self_id)
                role = m.get("role")
                print(f"[3] get_group_member_info OK -> role={role!r}")
            except ApiError as e:
                print(f"[3] get_group_member_info 失败 -> retcode={e.retcode} {e.wording or e.message}")
        else:
            print("[3] 跳过（第 1 步没拿到机器人自己的 QQ 号）")

        # ---- 4. 未处理的入群申请列表，NapCat 扩展接口，报错视为正常结果 ----
        try:
            sysmsg = await client.call_api("get_group_system_msg")
            dumped = json.dumps(sysmsg, ensure_ascii=False)
            print(f"[4] get_group_system_msg OK -> {dumped[:1000]}")
        except ApiError as e:
            print(f"[4] get_group_system_msg 报错（可能只是 NapCat 不支持这个动作）-> retcode={e.retcode} {e.wording or e.message}")

    finally:
        await client.stop()
        with contextlib.suppress(Exception):
            await runner

    # ---- 结论 ----
    if role in ("owner", "admin"):
        print(f"结论：机器人是该群的 {ROLE_CN[role]} ✅ 可以做入群审批（还需确认群的加群方式会产生申请事件）")
    elif role == "member":
        print("结论：机器人只是 普通成员 ❌ 收不到入群申请事件，做不了入群审批，需要先在群里把机器人设为管理员")
    else:
        print("结论：没能确认机器人角色（第 1/3 步失败），无法下结论")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
