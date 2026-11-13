"""往售前、售后群发群公告、传群文件（6099「群公告」页用，接口在 `admin_web.py`）。

2026-09-30 管理员：「让机器人可以在管理的售后和售前群可以发公告文档有接口还需要选择群聊」。

**只认群名带「售前」「售后」的群 + 日报群**。售前售后跟入群审批（`rules.py`）同一套认法；
日报群按 `.env` 的 REPORT_GROUP 认群号，不看群名（同一天他又说「加一个日报群」）。
这是他在页面上自己点了才发，不算「机器人往日报群主动发」（那个 09-30 定了只留 23:00 复盘一条）。
每次发之前都重新问 NapCat 要一遍群列表来核对群号，不信页面传上来的 —— 页面上勾错、或者有人手搓请求，
也发不进别的群。机器人得是群主或管理员才发得了公告，不是的照样列出来、标一下。

**一个群一个群地发，中间停一下**（`GAP`）：公告走的是 qun.qq.com 的网页接口，
几个群同一秒连发容易被风控。一个群失败不影响别的群，结果逐群返回，页面逐行显示。
同一时间只发一批（`busy`），页面上连点两下不会发两遍。

文件和公告图都用 base64 交给 NapCat：它跑在另一个容器里，看不到机器人这边的文件。
NapCat 的 WebSocket 一帧最大 50MB，所以文件上限跟资料上传一样 30MB（base64 之后 40MB）。
**公告图不能直接给 base64://**：NapCat 把它存成一个没有扩展名的临时文件再传给 QQ，
QQ 回「pic format is incorrect」（09-30 他往日报群发带图公告实测）。所以先用 `download_file`
让 NapCat 存成带扩展名的文件（`stage_image`），再把那个路径交给 `_send_group_notice`。
"""
from __future__ import annotations

import asyncio
import base64
import html
import logging
import re
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from .onebot import ApiError, OneBotClient, at, image_b64, text
from .rules import AFTERSALE_TAG, PRESALE_TAG

log = logging.getLogger(__name__)

REPORT_KIND = "日报群"
# 页面上的排法：售前、售后、日报群
_ORDER = {PRESALE_TAG: 0, AFTERSALE_TAG: 1, REPORT_KIND: 2}

# 两个群之间停多久
GAP = 1.0
# 群消息一条最多多少字。QQ 自己的上限在几千字，这里压短一点：@全体 的通知太长，手机上只看得见开头
MSG_MAX = 1500
# 传群文件：30MB 传到 QQ 要一两分钟，默认 30 秒等回包不够
FILE_TIMEOUT = 300.0


class AnnounceError(Exception):
    """发之前就不对（机器人没连上、一个群没选、勾了不认的群、上一批还没发完），整批都不发。"""


def kind(name: str) -> str | None:
    """售前 / 售后 / None（不归这里管）。两个都带的算售前，跟 rules.py 先判售前一样"""
    if PRESALE_TAG in name:
        return PRESALE_TAG
    if AFTERSALE_TAG in name:
        return AFTERSALE_TAG
    return None


def file_name(raw: str) -> str:
    """浏览器传上来的文件名只留最后一段：有的浏览器会带上 C:\\Users\\... 整条路径"""
    name = PureWindowsPath(PurePosixPath(raw).name).name.strip()
    return name[:120]


def image_ext(data: bytes) -> str | None:
    """按文件头认图片格式（不信文件名：改了后缀的 jpg 照样认成 jpg）。认不出 = None"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


# NapCat 的报错会把整张图的 base64 原样带出来（「群公告base64://iVBOR…设置失败」），页面上一大片
_B64 = re.compile(r"base64://[A-Za-z0-9+/=]+")


def _why(e: Exception) -> str:
    if isinstance(e, ApiError):
        return _B64.sub("（图片）", e.wording or e.message or str(e))
    return f"机器人跟 NapCat 断了：{e}"


@dataclass(frozen=True)
class Group:
    group_id: int
    name: str
    members: int
    kind: str
    # 机器人是不是群主 / 管理员：不是的发不了公告（传文件一般还行）。None = 没查出来
    admin: bool | None


class Announcer:
    def __init__(self, client: OneBotClient, report_group: int = 0) -> None:
        self.client = client
        # 日报群群号（REPORT_GROUP），0 = 没配，就不列
        self.report_group = report_group
        self._lock = asyncio.Lock()

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    async def groups(self) -> list[Group]:
        """机器人在的售前、售后群和日报群。售前、售后、日报群这么排，同类按群名排"""
        me = self.client.self_id
        if not self.client.connected or me is None:
            raise AnnounceError("机器人没连上 QQ，等它连上再发")
        out: list[Group] = []
        for g in await self.client.call_api("get_group_list") or []:
            name = str(g.get("group_name", ""))
            gid = int(g["group_id"])
            k = REPORT_KIND if self.report_group and gid == self.report_group else kind(name)
            if k is None:
                continue
            try:
                info = await self.client.call_api("get_group_member_info", group_id=gid, user_id=me)
                admin: bool | None = (info or {}).get("role") in ("owner", "admin")
            except ApiError:
                admin = None
            out.append(Group(gid, name, int(g.get("member_count") or 0), k, admin))
        out.sort(key=lambda g: (_ORDER[g.kind], g.name))
        return out

    async def _managed(self, group_ids: Iterable[int]) -> list[Group]:
        """核对群号，按勾的顺序返回（去重）。有一个不认就整批不发"""
        ids = list(dict.fromkeys(group_ids))
        if not ids:
            raise AnnounceError("一个群都没选")
        known = {g.group_id: g for g in await self.groups()}
        bad = [str(i) for i in ids if i not in known]
        if bad:
            raise AnnounceError(f"群 {'、'.join(bad)} 不是售前售后群或日报群，或者机器人不在里面，整批没发")
        return [known[i] for i in ids]

    async def _each(self, group_ids: Iterable[int], what: str, do: Callable[[Group], Awaitable[dict[str, Any]]]) -> list[dict[str, Any]]:
        if self._lock.locked():
            raise AnnounceError("上一批还在发，等它发完")
        async with self._lock:
            groups = await self._managed(group_ids)
            results: list[dict[str, Any]] = []
            for i, g in enumerate(groups):
                if i:
                    await asyncio.sleep(GAP)
                try:
                    extra = await do(g)
                except (ApiError, ConnectionError) as e:
                    log.warning("%s到群 %s（%s）失败：%s", what, g.group_id, g.name, e)
                    results.append({"group_id": g.group_id, "name": g.name, "ok": False, "error": _why(e)})
                else:
                    results.append({"group_id": g.group_id, "name": g.name, "ok": True, **extra})
            ok = sum(r["ok"] for r in results)
            log.info("%s：%d 个群成功、%d 个失败（%s）", what, ok, len(results) - ok, "、".join(g.name for g in groups))
            return results

    async def notice(
        self, group_ids: Iterable[int], content: str, *, image: bytes | None = None,
        pinned: bool = False, confirm: bool = False,
    ) -> list[dict[str, Any]]:
        """发群公告。`confirm` = 要群成员点「确认收到」"""
        content = content.strip()
        if not content:
            raise AnnounceError("公告内容是空的")
        if image and image_ext(image) is None:
            raise AnnounceError("公告图认不出是什么格式，换一张 png 或 jpg")
        params: dict[str, Any] = {"content": content, "pinned": int(pinned), "confirm_required": int(confirm)}
        staged: list[str] = []  # 图在 NapCat 那边的路径：发第一个群之前才存，整批共用一个

        async def do(g: Group) -> dict[str, Any]:
            if image and not staged:
                staged.append(await self.stage_image(image))
            extra = {"image": staged[0]} if staged else {}
            await self.client.call_api("_send_group_notice", group_id=g.group_id, **params, **extra)
            return {}

        return await self._each(group_ids, f"发群公告「{content[:20]}」", do)

    async def stage_image(self, data: bytes) -> str:
        """让 NapCat 把公告图存成带扩展名的文件，返回它那边的路径（为什么见模块开头）"""
        name = f"notice-{uuid.uuid4().hex[:12]}{image_ext(data)}"
        r = await self.client.call_api("download_file", base64=base64.b64encode(data).decode(), name=name)
        path = str((r or {}).get("file") or "")
        if not path:
            # 空路径交给 _send_group_notice 会被当成「没带图」照发 —— 客户看到的公告就少了图，宁可这个群报错
            raise ApiError("download_file", None, "NapCat 没存下公告图")
        return path

    async def upload(self, group_ids: Iterable[int], name: str, data: bytes) -> list[dict[str, Any]]:
        """传到群文件根目录。群里同时会冒出一条文件消息"""
        name = file_name(name)
        if not name:
            raise AnnounceError("文件没有名字")
        if not data:
            raise AnnounceError(f"{name} 是空文件")
        b64 = "base64://" + base64.b64encode(data).decode()

        async def do(g: Group) -> dict[str, Any]:
            r = await self.client.call_api("upload_group_file", _timeout=FILE_TIMEOUT, group_id=g.group_id, file=b64, name=name)
            return {"file_id": (r or {}).get("file_id")}

        return await self._each(group_ids, f"传群文件 {name}", do)

    async def message(
        self, group_ids: Iterable[int], content: str, *, at_all: bool = True, image: bytes | None = None,
    ) -> list[dict[str, Any]]:
        """往群里发一条普通聊天消息（10-09 他要的「群聊天，发的消息是 @全体 的，也要能选群」）。

        跟群公告的区别：公告挂在群公告栏、要点进去看；这个就是群里冒出一条消息，`at_all` 时带「@全体成员」，
        所有人都会收到提醒。**@全体 QQ 每天有次数**（10-09 实测五个群都是群 20 次 / 机器人 10 次），
        用完了这个群照样发出去、只是 @ 不响，所以发之前页面上先看剩几次（`at_all_remain`）。

        机器人得是群主或管理员才能 @全体，不是的话这个群报错、别的群照发。
        """
        content = content.strip()
        if not content and not image:
            raise AnnounceError("消息是空的")
        if len(content) > MSG_MAX:
            raise AnnounceError(f"消息太长了（{len(content)} 字），最多 {MSG_MAX} 字")
        if image and image_ext(image) is None:
            raise AnnounceError("图认不出是什么格式，换一张 png 或 jpg")
        segs: list[dict[str, Any]] = []
        if at_all:
            # 「@全体成员」后面跟个换行，正文另起一行，手机上读起来清楚
            segs += [at("all"), text("\n")]
        if content:
            segs.append(text(content))
        if image:
            segs.append(image_b64(image))

        async def do(g: Group) -> dict[str, Any]:
            mid = await self.client.send_group_msg(g.group_id, segs)
            return {"message_id": mid}

        return await self._each(group_ids, f"发群消息{'（@全体）' if at_all else ''}「{content[:20]}」", do)

    async def at_all_remain(self, group_id: int) -> dict[str, Any]:
        """这个群今天还能 @全体 几次。`group` 是全群剩的，`self` 是机器人自己剩的，两个取小的才是真能用的"""
        await self._managed([group_id])
        r = await self.client.call_api("get_group_at_all_remain", group_id=str(group_id)) or {}
        g, me = r.get("remain_at_all_count_for_group"), r.get("remain_at_all_count_for_uin")
        return {
            "can": bool(r.get("can_at_all")),
            "group": g, "self": me,
            "left": min(x for x in (g, me) if isinstance(x, int)) if any(isinstance(x, int) for x in (g, me)) else None,
        }

    async def notices(self, group_id: int) -> list[dict[str, Any]]:
        """这个群现在挂着的公告，新的在前（页面上看发出去没有、删发错的）"""
        await self._managed([group_id])
        rows = await self.client.call_api("_get_group_notice", group_id=group_id) or []
        rows.sort(key=lambda r: int(r.get("publish_time") or 0), reverse=True)
        out = []
        for r in rows:
            msg = r.get("message") or {}
            ts = int(r.get("publish_time") or 0)
            out.append({
                "notice_id": str(r.get("notice_id", "")),
                # 网页接口回来的是转义过的：换行是 &#10;，空格是 &nbsp;（还原成普通空格，不然复制出来是不换行空格）
                "text": html.unescape(str(msg.get("text", ""))).replace("\xa0", " "),
                "images": len(msg.get("images") or msg.get("image") or []),
                "sender_id": r.get("sender_id"),
                "publish_time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "",
                "read_num": r.get("read_num"),
            })
        return out

    async def delete_notice(self, group_id: int, notice_id: str) -> None:
        await self._managed([group_id])
        r = await self.client.call_api("_del_group_notice", group_id=group_id, notice_id=notice_id)
        # 这个动作 NapCat 不看底层结果，删不掉也回成功；底层结果原样在 data 里，自己看
        if isinstance(r, dict) and r.get("result", 0) != 0:
            raise ApiError("_del_group_notice", r.get("result"), str(r.get("errMsg") or "删不掉"))
        log.info("删了群 %s 的公告 %s", group_id, notice_id)


def group_json(g: Group) -> dict[str, Any]:
    return asdict(g)
