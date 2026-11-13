"""把「怎么退款」「咋退钱」「退款流程走哪」归成同一个问题。

不归并的话，日报里同一件事会被 20 种问法拆成 20 条各问 1 次，
「哪个问题问得多」就看不出来了——而这正是你要的那个反馈。

归并阈值默认 0.82，比标准答案的命中线（0.78）**高**。看着反直觉，理由是：
命中线宽一点的代价是偶尔用相近的答案回答（还有重写自检兜着），
而归并线宽一点的代价是把两个不同问题并成一类，日报直接变成假数据，
你照着假数据定答案会错得更远。统计宁可分得细，也别并错。
"""
from __future__ import annotations

import array
import logging

from .retrieve import Retriever, dot
from .store import KBStore

log = logging.getLogger(__name__)


async def assign(store: KBStore, retriever: Retriever, question: str, qvec: list[float], threshold: float) -> int:
    """把这次提问归到一个问题类，返回 cluster_id。找不到相似的就新建一类。

    新建时拿这次的原话当 label。后面同类的问法都并进来，label 不再更新——
    第一次出现的说法通常最自然，改成后来的只会让日报读起来忽然变陌生。
    """
    near = await retriever.nearest_cluster(qvec)
    if near and near[1] >= threshold:
        cid, score = near
        store.touch_cluster(cid)
        log.debug("提问归入 #%d（相似度 %.3f）", cid, score)
        return cid
    cid = store.new_cluster(question, qvec)
    log.debug("提问新建问题类 #%d：%.40s", cid, question)
    return cid


def link_similar(store: KBStore, entry_id: int, entry_vecs: list[list[float]], threshold: float) -> list[int]:
    """你刚定了一条标准答案，把所有相似的待办问题类都挂到它上面。返回挂上的 id。

    为什么要多挂：客户的问法五花八门，同一件事很可能已经攒了三四个待办类
    （相似但没到归并线）。你只答了一条，剩下几条还赖在待办里，
    下次日报又催你答同一件事——你会以为我没记住。
    和归并用同一个阈值：既然像到能算同一个问题，就该一起结掉。

    `entry_vecs` 是这条答案所有问法的向量，取最大相似度——只要待办类
    像其中任何一个问法，就算同一件事。

    同步函数，纯读 + 计算。调用方用 asyncio.to_thread 包起来，别在事件循环里跑。
    """
    if not entry_vecs:
        return []
    qs = [array.array("f", v) for v in entry_vecs]
    linked: list[int] = []
    for cid, vec in store.cluster_vecs():
        cluster = store.get_cluster(cid)
        if cluster is None or cluster.answered or cluster.resolved:
            continue
        best = max((dot(vec, q) for q in qs if len(q) == len(vec)), default=0.0)
        if best >= threshold:
            store.attach_entry(cid, entry_id)
            linked.append(cid)
            log.info("问题类 #%d「%.30s」挂到标准答案 #%d（相似度 %.3f）", cid, cluster.label, entry_id, best)
    return linked
