"""把 OneBot 11 上报的原始 dict 解析成带类型的事件对象。

只建模业务上真要用的字段，其余的留在 .raw 里随时可取。
事件的 key（如 "message.group"、"request.group.add"）是分发器匹配用的。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Event:
    raw: dict[str, Any]
    time: int
    self_id: int
    post_type: str

    @property
    def key(self) -> str:
        return self.post_type


@dataclass
class MessageEvent(Event):
    message_type: str  # group / private
    message_id: int
    user_id: int
    sender: dict[str, Any]
    message: list[dict[str, Any]]  # array 格式的消息段
    raw_message: str

    @property
    def key(self) -> str:
        return f"message.{self.message_type}"

    @property
    def sender_name(self) -> str:
        """群名片优先，没有就昵称。只用来展示，业务判断一律用 user_id——昵称能重名。"""
        return self.sender.get("card") or self.sender.get("nickname") or str(self.user_id)

    @property
    def plain_text(self) -> str:
        """只拼文字段。图片 / 表情 / @ 一概不要，给关键词匹配和 AI 用。"""
        return "".join(s["data"].get("text", "") for s in self.message if s["type"] == "text").strip()

    @property
    def at_me(self) -> bool:
        """有人点名 @ 了机器人。@全体成员 不算，不然每次全体通知机器人都要搭话。"""
        return any(s["type"] == "at" and str(s["data"].get("qq")) == str(self.self_id) for s in self.message)


@dataclass
class GroupMessage(MessageEvent):
    group_id: int = 0
    sub_type: str = "normal"


@dataclass
class PrivateMessage(MessageEvent):
    sub_type: str = "friend"


@dataclass
class NoticeEvent(Event):
    notice_type: str
    sub_type: str = ""
    group_id: int | None = None
    user_id: int | None = None

    @property
    def key(self) -> str:
        return f"notice.{self.notice_type}"


@dataclass
class RequestEvent(Event):
    request_type: str  # friend / group
    sub_type: str  # group: add / invite
    user_id: int
    flag: str  # 回复申请时要带回去的凭据
    comment: str = ""  # 入群答案 / 验证信息
    group_id: int | None = None

    @property
    def key(self) -> str:
        return f"request.{self.request_type}.{self.sub_type}" if self.sub_type else f"request.{self.request_type}"


@dataclass
class MetaEvent(Event):
    meta_event_type: str  # heartbeat / lifecycle
    sub_type: str = ""
    status: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"meta_event.{self.meta_event_type}"


def _segments(message: Any) -> list[dict[str, Any]]:
    """我们配的是 array 格式；万一 NapCat 那边被改成 string，也别崩，当成一段纯文字。"""
    if isinstance(message, list):
        return message
    return [{"type": "text", "data": {"text": str(message)}}]


def parse(raw: dict[str, Any]) -> Event:
    base = dict(raw=raw, time=int(raw.get("time", 0)), self_id=int(raw.get("self_id", 0)), post_type=raw.get("post_type", ""))
    pt = base["post_type"]

    if pt == "message":
        common = dict(
            message_type=raw["message_type"],
            message_id=int(raw["message_id"]),
            user_id=int(raw["user_id"]),
            sender=raw.get("sender") or {},
            message=_segments(raw.get("message")),
            raw_message=raw.get("raw_message", ""),
            sub_type=raw.get("sub_type", ""),
        )
        if raw["message_type"] == "group":
            return GroupMessage(**base, **common, group_id=int(raw["group_id"]))
        return PrivateMessage(**base, **common)

    if pt == "notice":
        return NoticeEvent(
            **base,
            notice_type=raw.get("notice_type", ""),
            sub_type=raw.get("sub_type", ""),
            group_id=int(raw["group_id"]) if raw.get("group_id") else None,
            user_id=int(raw["user_id"]) if raw.get("user_id") else None,
        )

    if pt == "request":
        return RequestEvent(
            **base,
            request_type=raw.get("request_type", ""),
            sub_type=raw.get("sub_type", ""),
            user_id=int(raw["user_id"]),
            flag=str(raw.get("flag", "")),
            comment=raw.get("comment", "") or "",
            group_id=int(raw["group_id"]) if raw.get("group_id") else None,
        )

    if pt == "meta_event":
        return MetaEvent(
            **base,
            meta_event_type=raw.get("meta_event_type", ""),
            sub_type=raw.get("sub_type", ""),
            status=raw.get("status") or {},
        )

    return Event(**base)
