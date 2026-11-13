"""入群审批规则引擎。

纯函数，不碰网络、不碰数据库，方便单测和演练——规则写错是会把陌生人放进客户群的，
所以刻意做成"输入群名和答案，输出一个决定"，可以离线反复跑。

规则（2026-09-22 定版，2026-10-08 加了自动拒绝，见 开发文档.md §5）：

    群名含「售前」                    → 自动同意，答案看都不看
    群名含「售后」且答案以 sub2 开头   → 自动同意
    群名含「售后」但答案不是 sub2 开头 → **自动拒绝**，理由发给对方
    其余一切情况                      → 转人工

**2026-10-08 之前没有「自动拒绝」分支**，当时的理由是：自动放行错了还能踢，自动拒绝
误伤真客户不可逆。改成自动拒是管理员定的（原话「格式不对的直接拒绝就可以」），他是
看着数据定的 —— 当时积压里有两条格式像真订单号的（`sub_20261007GZbc4j7n`、
`APP-20260922-001499`），以后这种会被直接拒掉，这个代价他认。

**拒绝不是封死**：理由会发给对方（默认「请输入正确订单号」），QQ 允许改对了再申请。
所以「不可逆」那条顾虑比当初写的轻 —— 但误拒一个懒得再申请的真客户，还是丢了这个客户。

**自动拒只在这一个分支**。群名既不含售前也不含售后的照旧转人工 —— 那是群配置没弄对，
不是客户答错，拒了是冤枉人。有人邀请机器人进别的群也照旧转人工（那道闸在 handlers/approval.py）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

PRESALE_TAG = "售前"
AFTERSALE_TAG = "售后"
DEFAULT_ANSWER_PREFIX = "sub2"

# 「答案：xxx」/「答案: xxx」，取冒号后面全部（答案可能换行）
_ANSWER_RE = re.compile(r"答案\s*[:：]\s*(.*)", re.S)


class Action(str, Enum):
    APPROVE = "approve"  # 自动放行
    MANUAL = "manual"  # 转人工
    REJECT = "reject"  # 自动拒绝（2026-10-08 加，只给「售后群但答案不对」用）


@dataclass(frozen=True)
class Decision:
    action: Action
    reason: str  # 人话，写进日志和数据库，事后能看出当时为什么这么判

    @property
    def auto(self) -> bool:
        return self.action is Action.APPROVE

    @property
    def deny(self) -> bool:
        """要不要自动拒。**不要用 `not auto` 代替** —— 转人工既不是放行也不是拒绝"""
        return self.action is Action.REJECT


def answer_candidates(comment: str) -> list[str]:
    """把入群验证信息拆成几种可能的「答案」解读。

    comment 是腾讯服务端原样发下来的 postscript，NapCat 只透传不加工（读源码确认过），
    所以它到底是纯答案 `sub2-12345`，还是带问题前缀 `问题：订单号\\n答案：sub2-12345`，
    **实测之前不知道**。赌单一解析格式，猜错就是所有真客户全被挡去人工。

    所以不赌：「答案：」后面的内容、最后一行、第一行、整串，四种都当候选，命中一个就算。
    反方向的风险（误放行）很小——要误放行得有人正好把 sub2 写在某一行的开头。
    """
    text = (comment or "").strip()
    if not text:
        return []
    out = []
    m = _ANSWER_RE.search(text)
    if m:
        out.append(m.group(1).strip())
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if lines:
        out.append(lines[-1])  # 问题在前、答案在后是最常见的排版
        out.append(lines[0])
    out.append(text)
    # 去重但保持顺序，纯粹是为了日志里好看
    seen: set[str] = set()
    return [c for c in out if c and not (c in seen or seen.add(c))]


def hit_prefix(comment: str, prefix: str) -> bool:
    """答案是不是以指定前缀开头。大小写不敏感——客户手打，不该因为大写被挡。"""
    p = prefix.strip().lower()
    if not p:
        return False
    return any(c.lower().startswith(p) for c in answer_candidates(comment))


def decide(group_name: str, comment: str, prefix: str = DEFAULT_ANSWER_PREFIX) -> Decision:
    """按群名和入群答案判一个结果。group_name 取不到时传空串，会落到兜底转人工。"""
    name = group_name or ""

    # 售前优先：一个群名同时含售前和售后时，走放行宽的那条。
    # 必须有确定的优先级，否则同样的输入可能出现不同结果，事后没法解释。
    if PRESALE_TAG in name:
        return Decision(Action.APPROVE, f"群名含「{PRESALE_TAG}」，直接放行")

    if AFTERSALE_TAG in name:
        if hit_prefix(comment, prefix):
            return Decision(Action.APPROVE, f"群名含「{AFTERSALE_TAG}」且答案以 {prefix} 开头")
        # 2026-10-08 起直接拒，不再攒着等人批（他定的）。理由发给对方，改对了能重新申请
        return Decision(Action.REJECT, f"群名含「{AFTERSALE_TAG}」，但答案不是 {prefix} 开头")

    return Decision(Action.MANUAL, f"群名不含「{PRESALE_TAG}」也不含「{AFTERSALE_TAG}」，兜底转人工")
