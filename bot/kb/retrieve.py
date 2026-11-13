"""混合检索：向量余弦 + FTS5 关键词。

**为什么两路都要**，2026-09-22 实测的四个例子说明了分工：

| 提问 | 关键词 | 向量 |
|---|---|---|
| 「退款」「发票」「到账」 | ✅ 命中 | ✅ |
| 「怎么把钱退回来」 | ❌ 和资料没有共同的 2-gram | ✅ 0.763（方案 §10.4） |
| 「开专票」 | ❌ 资料写的是「专用发票」 | ✅ |

关键词管字面精确（型号、订单号、专有名词，向量常常摊平），向量管换了说法。

**关键词的权重故意压得很低（0.10 / 0.25）。** 因为 bm25 的分是归一化的
相对分——一批结果里最相关的那条恒等于 1.0，哪怕它其实毫不相关。
权重给高了，一个语义完全不搭但字面撞了两个字的块就能冒到命中线以上，
拿着错资料去答比答不上来糟得多。所以它只负责把排序往上推一点。
"""
from __future__ import annotations

import array
import asyncio
import logging
import operator
import re
from dataclasses import dataclass, field

from .store import KBStore

log = logging.getLogger(__name__)

# 关键词分的权重。向量分是 0~1 的语义相似度，是主信号
# ⚠️ 标准答案命中要严，所以权重压到 0.10。但**它确实能把答案推过命中线** ——
# 关键词分是归一化的相对分（`store.py` 的 `s / min(各行 bm25)`），
# 一批结果里头名恒等于 1.0000，所以只要关键词那路召回到东西，头名就恒定拿满 +0.10。
# 0.68~0.78 这条带就是靠这个恒满的加分越过 0.78 的。
# **这是既定状态，不是待修项**：靠 +0.10 越线的那几次全部答对了，两种修法实测都更糟
# （详见 进度.md 第五节第 22 条）。改这个常数或动别名之前先看那条。
KW_WEIGHT_KB = 0.10
KW_WEIGHT_RAG = 0.25  # 找资料片段可以松：召回错了还有模型和阈值兜
TOP_K = 5
# 先按分数捞 TOP_K × 这个数，筛掉空壳块之后再切到 TOP_K
OVERFETCH = 4

# 分隔线、表头残片这类没有正文的字符。抓下来的文档里 926 块有 104 块
# （11%）正文就是一个 `***` 或 `---`
_NO_TEXT = re.compile(r"[\s*\-#=_|·—–~`>]+")
_MIN_TEXT = 12


def _has_text(body: str) -> bool:
    """这一块有没有真正的内容。

    **空壳块是这套检索里最贵的一种浪费。** 切块时每块都跟着上一级标题走，
    所以一个只有 `***` 的块照样带着「Chatbox」这个标题去算向量 ——
    问「chatbox连不上」时它能拿 0.765 的高分，排在第一，
    然后给模型的资料里是一行星号。2026-09-23 实测那次召回的 5 块里有 3 块是这样，
    模型看着三行星号自然就说「资料里没有」。

    **在检索这一层筛，不在入库那一层。** 入库要重跑一遍 ingest（要花钱算向量、
    要停机），而且下次抓文档还会再进来一批。这里筛是幂等的，下次换切块策略
    也不会互相干扰。
    """
    return len(_NO_TEXT.sub("", body)) >= _MIN_TEXT


class DimensionMismatch(RuntimeError):
    """库里的向量和当前 embedding 模型维度不一致。

    换了 EMBEDDING_MODEL 就会这样，旧向量和新向量算点积得到的是垃圾分数。
    必须重新跑一遍资料导入，不能悄悄按错分数回答。
    """


@dataclass
class Hit:
    id: int
    score: float
    vec_score: float
    kw_score: float
    title: str = ""
    body: str = ""
    url: str = ""  # 这块出自哪个网页，答案里附上客户能自己点过去核对


@dataclass
class EntryHit:
    entry_id: int
    score: float
    vec_score: float
    kw_score: float
    phrasing: str  # 命中的是哪个问法，日志里能看出别名有没有起作用


@dataclass
class _Index:
    """向量的内存副本。每次问答都从 SQLite 读全部向量再解包太浪费，
    靠 store 的 revision 判断失效——资料导入、改标准答案都会让它 +1。"""

    revision: int = -1
    chunks: list[tuple[int, array.array]] = field(default_factory=list)
    entries: list[tuple[int, str, array.array]] = field(default_factory=list)

    @property
    def dim(self) -> int:
        if self.chunks:
            return len(self.chunks[0][1])
        return len(self.entries[0][2]) if self.entries else 0


def dot(a: array.array, b: array.array) -> float:
    """两个单位向量的点积 = 余弦相似度。

    zip 在长度不等时会静默截断，算出来是个看起来正常的错分数，
    所以维度不一致必须在外层拦住（见 Retriever._check）。
    """
    return sum(map(operator.mul, a, b))


class Retriever:
    def __init__(self, store: KBStore) -> None:
        self._store = store
        self._index = _Index()
        self._lock = asyncio.Lock()

    async def _ensure(self) -> _Index:
        """按需重建向量缓存。锁住是防止两条提问同时进来重复重建。"""
        rev = await asyncio.to_thread(self._store.revision)
        if rev == self._index.revision:
            return self._index
        async with self._lock:
            if rev == self._index.revision:
                return self._index
            chunks, entries = await asyncio.to_thread(self._load)
            self._index = _Index(revision=rev, chunks=chunks, entries=entries)
            log.info("向量索引已重建：%d 个资料块、%d 个问法，%d 维", len(chunks), len(entries), self._index.dim)
            return self._index

    def _load(self) -> tuple[list[tuple[int, array.array]], list[tuple[int, str, array.array]]]:
        return self._store.chunk_vecs(), self._store.entry_vecs()

    @staticmethod
    def _check(qvec: array.array, idx: _Index) -> None:
        if idx.dim and len(qvec) != idx.dim:
            raise DimensionMismatch(
                f"提问向量 {len(qvec)} 维，库里是 {idx.dim} 维。"
                "多半是 EMBEDDING_MODEL 换了——要重新跑 uv run -m bot.kb.ingest 才能用"
            )

    # ---- 标准答案 ----

    async def best_entry(self, question: str, qvec: list[float]) -> EntryHit | None:
        """找最像的标准答案。返回的 score 还没和阈值比，判命中是调用方的事。"""
        idx = await self._ensure()
        if not idx.entries:
            return None
        q = array.array("f", qvec)
        self._check(q, idx)
        kw = await asyncio.to_thread(self._store.fts_search, "kb_fts", question, 20)

        def compute() -> EntryHit | None:
            best: EntryHit | None = None
            for entry_id, phrasing, vec in idx.entries:
                v = dot(vec, q)
                k = kw.get(entry_id, 0.0)
                total = min(1.0, v + KW_WEIGHT_KB * k)
                # **总分一样比向量分**：总分封顶 1.0，两条都是 1.0 时原来按顺序取第一条（编号小的赢）。
                # 2026-09-28 真踩过：「c-pro和c-max模型有什么区别」#13（渠道区别）和 #14（模型区别）
                # 总分都是 1.0，#13 编号小就赢了，答成了渠道区别
                if best is None or (total, v) > (best.score, best.vec_score):
                    best = EntryHit(entry_id=entry_id, score=total, vec_score=v, kw_score=k, phrasing=phrasing)
            return best

        return await asyncio.to_thread(compute)

    async def candidates(self, question: str, qvec: list[float], *, k: int = 3) -> list[EntryHit]:
        """挑几条标准答案**去问判断模型**（handlers/qa.py 的第三档：没 @ 我的问题）。

        顺序：**先放总分第一名**（关键词顶上去的那种，字面上最像），
        再按**向量分**排（语义最像的）。

        为什么要混着来（2026-10-16 真机）：客户问「为什么只能用国内大模型了」，
        总分第一名是 #81 —— 向量才 0.645，靠关键词 +0.10 顶上来的，答的不是这件事，
        判断模型判 NO 整条就哑了；而真正答得了这条的 #11 向量 0.733，**总分排不进前 3**
        （#15、#16 的向量分比它低，也都靠关键词加分挤在前面）。
        只按总分取前几名会一直挑到「字面像、语义不像」的那几条，所以：
        第一位保总分，后面按向量，谁答得了用谁。
        """
        idx = await self._ensure()
        if not idx.entries:
            return []
        q = array.array("f", qvec)
        self._check(q, idx)
        kw = await asyncio.to_thread(self._store.fts_search, "kb_fts", question, 20)

        def compute() -> list[EntryHit]:
            hits = [
                EntryHit(
                    entry_id=entry_id, score=min(1.0, dot(vec, q) + KW_WEIGHT_KB * kw.get(entry_id, 0.0)),
                    vec_score=dot(vec, q), kw_score=kw.get(entry_id, 0.0), phrasing=phrasing,
                )
                for entry_id, phrasing, vec in idx.entries
            ]
            by_total = sorted(hits, key=lambda h: (h.score, h.vec_score), reverse=True)
            by_vec = sorted(hits, key=lambda h: (h.vec_score, h.score), reverse=True)
            out: list[EntryHit] = []
            for h in [by_total[0], *by_vec]:  # 总分第一名先问，其余按向量分
                if h.entry_id not in {x.entry_id for x in out}:
                    out.append(h)
                if len(out) >= k:
                    break
            return out

        return await asyncio.to_thread(compute)

    # ---- 资料 ----

    async def search_chunks(self, question: str, qvec: list[float], *, top_k: int = TOP_K) -> list[Hit]:
        """找最相关的资料片段，分高的在前。**只返回真有正文的块**，见 _has_text。"""
        idx = await self._ensure()
        if not idx.chunks:
            return []
        q = array.array("f", qvec)
        self._check(q, idx)
        kw = await asyncio.to_thread(self._store.fts_search, "chunks_fts", question, 30)

        def compute() -> list[Hit]:
            scored = []
            for cid, vec in idx.chunks:
                v = dot(vec, q)
                k = kw.get(cid, 0.0)
                scored.append(Hit(id=cid, score=min(1.0, v + KW_WEIGHT_RAG * k), vec_score=v, kw_score=k))
            # 关键词命中但向量没进前列的，也给一个席位：型号、订单号这类
            # 字面精确匹配常常在语义上摊平，靠 kw 才捞得回来
            scored.sort(key=lambda h: h.score, reverse=True)
            # **多捞几个再筛**：空壳块要读出正文才认得出来，先切到 top_k
            # 就是让它们白占席位（见下面 _has_text 那段）
            return scored[: top_k * OVERFETCH]

        hits = await asyncio.to_thread(compute)
        bodies = await asyncio.to_thread(self._store.chunks_by_ids, [h.id for h in hits])
        out = []
        for h in hits:
            h.title, h.body, h.url = bodies.get(h.id, ("", "", ""))
            if _has_text(h.body):
                out.append(h)
            if len(out) == top_k:
                break
        return out

    async def nearest_cluster(self, qvec: list[float]) -> tuple[int, float] | None:
        """最像的问题类。归并统计用，见 cluster.py。"""
        vecs = await asyncio.to_thread(self._store.cluster_vecs)
        if not vecs:
            return None
        q = array.array("f", qvec)
        if len(vecs[0][1]) != len(q):
            # 换过 embedding 模型。聚类是统计用途，不值得为它中断问答，
            # 记一条日志后当成「没有相似的」——后面会新建一类
            log.warning("问题聚类向量 %d 维、提问 %d 维，跳过归并", len(vecs[0][1]), len(q))
            return None

        def compute() -> tuple[int, float]:
            best_id, best = vecs[0][0], dot(vecs[0][1], q)
            for cid, vec in vecs[1:]:
                s = dot(vec, q)
                if s > best:
                    best_id, best = cid, s
            return best_id, best

        return await asyncio.to_thread(compute)
