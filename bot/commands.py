"""哪些指令已经有人认领了。只为一件事：让「不认识的指令」这句提示别冤枉人。

**起因是真机踩的。** 2026-09-23 00:27，超管在私聊打 `/答 23 …`，收到的是
「不认识的指令 /答」。他以为是自己标点打错，把逗号去掉又试了一次，还是不行，
标准答案库因此一条都没录上。

根因是条缝：`/y /n /ls` 长在 `handlers/admin.py` 的**私聊**里，
`/答 /待办 /高频` 长在 `handlers/kb_admin.py` 的**群**里。「打指令」这一个
动作被劈成两半，而「不认识的指令」这句兜底是个**全局判断**，却只长在其中
一半里 —— 它不知道另一半认什么。

为什么不让 admin.py 直接 import kb_admin 的指令表：那样耦合方向就成了
「审批模块依赖知识库模块」，而且下次谁再加一张指令表，同样的坑再踩一次。
这里登记一下，两边互不相识也不会打架。

**按场景分开记（group / private），不是记成一个大集合。** 同一条指令完全
可能只在群里有人接、私聊没人接。不分场景的话，kb_admin 还没接私聊那段时间，
admin.py 会以为「有人管」而闭嘴，超管打 `/答` 一条回复都收不到 ——
**静默比说错话难查得多**，至少「不认识的指令」还能让人知道机器人收到了。

**claim() 必须在 register() 里调，不能放模块级。** `kb/wiring.py` 模块级就
`from ..handlers import kb_admin`，也就是说不管 AI 问答有没有启用，那个模块
都会被 import 一遍。放模块级 = 问答被黑名单拦下（或 key 没配）时 `/答` 照样
被认领，但根本没有处理器在接，又退回静默。放 register() 里就对了：没启用就
没认领，兜底照常说话。
（先后顺序不用担心：认领发生在 register() 阶段，查询发生在事件到达时，
 而 `__main__._run()` 里所有 register() 都跑在 `client.run()` 之前。）
"""
from __future__ import annotations

from collections.abc import Iterable

GROUP = "group"
PRIVATE = "private"

_claimed: dict[str, set[str]] = {}


def claim(scope: str, names: Iterable[str]) -> None:
    """登记「我在这个场景下认这些指令名」。scope 用 GROUP / PRIVATE。

    重复登记无所谓，是并集。指令名统一按小写存。
    """
    _claimed.setdefault(scope, set()).update(n.lower() for n in names)


def claimed(scope: str, name: str) -> bool:
    """这个场景下这条指令有没有人接。没人接才轮到「不认识的指令」那句话。"""
    return name.lower() in _claimed.get(scope, frozenset())
