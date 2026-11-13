"""知识库.md 的导出与反向加载。

你要的双向：群里发 `/答` → 自动写进 md（不用你操作）；你在电脑上改完 md
→ 群里发 `/同步` 才生效。

**为什么反向不做自动监听。** 两边同时改就会互相覆盖，而覆盖是静默的——
你晚上在群里答了 5 条，我这边正好监听到你白天改的旧文件，5 条全没了，
而且没人会发现。多打一条 `/同步` 换来「什么时候生效由你说」，值得。

`/同步` 是**以 md 为准的全量覆盖**，md 里没有的条目会被删掉。所以这里堆了
三道保险，都是冲着「一次误操作清空整个知识库」来的：

1. 每次加载前先把当前库导出成 `知识库.备份-时间戳.md`
2. md 解析出 0 条而库里有货 → 直接拒绝（文件被清空、编码错、路径写错都长这样）
3. 要删的超过 3 条且超过总数一半 → 拒绝，要你发 `/同步 确认` 再来一次
"""
from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .llm import LLM
from .store import BY_MD, DB_PATH, KBStore

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
# **真文件的位置，写死**：`KB_FILE` 会被离线用例重定向（test_crawl / test_review …），
# 硬保险要拿这个不动的来比，不然「临时库写真文件」那道判断会跟着 KB_FILE 一起漂
REAL_KB_FILE = ROOT / "data" / "知识库.md"
KB_FILE = REAL_KB_FILE  # 正常路径用它；离线用例可以改它

HEADER = """# 标准答案库

> 机器人回答的第一依据。命中这里的问题不查资料、不赌模型。
>
> - 群里发 `/答 编号 内容` 会自动写进这个文件，你不用管
> - **你直接改这个文件后，要在群里发 `/同步` 才生效**
> - 同步是以这个文件为准的全量覆盖：删掉一节就等于删掉那条答案
> - 新加一条不用写编号，`## 你的问题` 就行，同步后我会补上编号
"""

# `## 12. 怎么退款` / `## 怎么退款`（手写新条目不用编号）
_H2 = re.compile(r"^##\s+(?:(\d+)\s*[.、]\s*)?(.+?)\s*$")
_ALIAS = re.compile(r"^\*\*(?:也这么问|别名|其它问法|其他问法)[:：]\*\*\s*(.*)$")
_COMMENT = re.compile(r"^\s*<!--.*-->\s*$")
_ALIAS_SEP = re.compile(r"\s*[/｜|]\s*")


@dataclass
class Parsed:
    entry_id: int | None
    question: str
    answer: str
    aliases: list[str] = field(default_factory=list)


@dataclass
class LoadResult:
    added: int = 0
    updated: int = 0
    deleted: int = 0
    unchanged: int = 0
    backup: str = ""
    refused: str = ""  # 非空 = 什么都没做，这是原因
    needs_confirm: bool = False

    @property
    def ok(self) -> bool:
        return not self.refused

    def summary(self) -> str:
        if self.refused:
            return self.refused
        bits = []
        for label, n in (("新增", self.added), ("更新", self.updated), ("删除", self.deleted)):
            if n:
                bits.append(f"{label} {n} 条")
        body = "、".join(bits) or "没有变化"
        tail = f"，{self.unchanged} 条没动" if self.unchanged else ""
        return f"同步完成：{body}{tail}"


# ---- 导出 ----

def dump(store: KBStore) -> str:
    """把库里的标准答案渲染成 md。"""
    out = [HEADER]
    for e in store.entries():
        out.append(f"\n## {e.id}. {e.question}\n")
        extra = [a.strip() for a in e.aliases.splitlines() if a.strip()]
        if extra:
            out.append(f"**也这么问：** {' / '.join(extra)}\n")
        out.append(f"\n{e.answer.strip()}\n")
        out.append(f"\n<!-- 命中 {e.hits} 次 | 更新 {e.updated_at} | 来源 {e.source} -->\n")
    if len(out) == 1:
        out.append("\n_还没有标准答案。群里发 `/加 一句大白话` 就能加。_\n")
    return "".join(out)


_FINGERPRINT = "kb_md_sha1"  # meta 表里记上次导出内容的指纹，见 write()


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def write(store: KBStore, path: Path = KB_FILE, *, keep_handedit: bool = True) -> Path:
    """导出到文件。每次 /答 /改 /删 之后都会调，所以 md 永远是最新的。

    **覆盖前先认出「文件被手改过还没同步」，是就先留一份原文。**

    2026-09-24 被这件事咬过一次，真机时间线：
      01:2x  有人直接改 data/知识库.md（改了 #2 的正文和别名，末尾加了一条新答案）
      01:25  群里发 `/答 88 …` → do_answer 调 write() → **按库里的内容整份覆盖**，
             三处手改当场没了
      01:26  发 `/同步` → 读到的已经是重新生成的文件 → 报「没有变化，9 条没动」

    每一步都按设计在跑，合起来是静默丢数据：`/同步` 那道安全闸的前提是
    「文件里的改动一直在那儿等着」，而 `/答` `/改` `/删` `/导出` 四个口子
    都会在它之前把文件重写掉。**头部写着「你直接改这个文件后要发 /同步 才生效」，
    没写「在这之前别用 /答」** —— 靠人记住顺序是不行的。

    **为什么是备份，不是拒绝写：** 拒绝的话 `/答` 就失败了，而客户还在群里等答案，
    这是拿一件确定的急事去换一件不确定的事。备份两边都保住：命令照常成功，
    手改的原文留在 `知识库.手改未同步-时间戳.md` 里，捡得回来。

    指纹存在库的 meta 表里，不存成文件：存文件的话它自己也会被人删、被 gitignore
    规则扫掉，而这个判断一旦失灵就是静默失灵 —— 又回到今晚这个坑。
    **指纹对不上就当手改过**（第一次跑、库换过、文件被别的程序动过都算），
    代价只是多一份备份文件。

    `keep_handedit=False` 只给 `load()` 结尾那次回写用：那时文件里的手改
    **刚刚被读进库**，不是「还没同步」，而 `load()` 自己已经备份过一份了。
    再留一份就是每次 `/同步` 都多一个文件，看着像出过事 —— 备份文件多到分不清
    哪份要紧，跟没有备份差不多。
    """
    path = Path(path)
    # **硬保险（2026-10-16）**：临时库（离线用例、脚本自己开的库）一律不许往真那份写。
    #
    # 真踩过：`tests/test_assistant.py` / `tests/test_chat_record.py` 只 patch 了 `sync.write`
    # 的**默认路径**（`lambda store, path=TMP/…`），可 `review.accept` 走的是
    # `sync.write(store, kb_file=正式那份)` —— 显式传参，patch 拦不住。跑一次那套用例，
    # `data/知识库.md` 就被冲成临时库里的 1 条（真机：11:15 冲成 1 条，之后每跑一次测试
    # 又冲一次，一路冲到 15:19）。而 `/同步` 是**以文件为准的全量覆盖** ——
    # 再发一次 `/同步 确认`，121 条标准答案就全没了。
    if Path(path).resolve() == REAL_KB_FILE.resolve() and Path(store.path).resolve() != DB_PATH.resolve():
        log.warning(
            "拒绝把临时库（%s）导出到真文件 %s —— 这是离线用例漏了重定向，"
            "正常的 /答 /同步 不受影响", store.path, REAL_KB_FILE,
        )
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    body = dump(store)
    if keep_handedit and path.exists():
        old = path.read_text(encoding="utf-8")
        if old.strip() and old != body and _sha1(old) != (store.get_meta(_FINGERPRINT) or ""):
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            keep = path.with_name(f"{path.stem}.手改未同步-{stamp}{path.suffix}")
            # **同名就往后加 -2 -3**：时间戳只到秒，同一秒里连着两次导出
            # （`/答` 紧跟一次 `/导出` 就会）后一份会把前一份盖掉 ——
            # 备份互相覆盖等于没备份，正是这个函数要防的那件事
            n = 2
            while keep.exists():
                keep = path.with_name(f"{path.stem}.手改未同步-{stamp}-{n}{path.suffix}")
                n += 1
            keep.write_text(old, encoding="utf-8")
            log.warning(
                "%s 被手改过还没 /同步，这次导出会覆盖掉它。原文留在 %s ——"
                "要让那些改动生效，把它的内容贴回 %s 再发 /同步",
                path.name, keep.name, path.name,
            )
    path.write_text(body, encoding="utf-8")
    store.set_meta(_FINGERPRINT, _sha1(body))
    return path


def backup(store: KBStore, path: Path = KB_FILE) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = path.with_name(f"{path.stem}.备份-{stamp}{path.suffix}")
    dest.write_text(dump(store), encoding="utf-8")
    return dest


# ---- 解析 ----

def parse(md: str) -> list[Parsed]:
    """解析 md。宽容一点：全角冒号、编号后跟顿号、别名用 / 或 ｜ 分隔都认。

    手写的条目可以没有编号，同步时当新增处理。
    """
    items: list[Parsed] = []
    cur: Parsed | None = None
    body: list[str] = []

    def flush() -> None:
        if cur is not None:
            cur.answer = "\n".join(body).strip()
            if cur.question and cur.answer:
                items.append(cur)
            elif cur.question:
                log.warning("知识库.md 里「%.30s」没有答案正文，跳过", cur.question)

    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("# ") or stripped.startswith(">"):
            continue  # 文件标题和说明块
        m = _H2.match(stripped)
        if m:
            flush()
            cur = Parsed(entry_id=int(m.group(1)) if m.group(1) else None, question=m.group(2).strip(), answer="")
            body = []
            continue
        if cur is None:
            continue
        if _COMMENT.match(line):
            continue
        a = _ALIAS.match(stripped)
        if a:
            cur.aliases = [x.strip() for x in _ALIAS_SEP.split(a.group(1)) if x.strip()]
            continue
        body.append(line)
    flush()
    return items


# ---- 反向加载 ----

async def load(store: KBStore, llm: LLM, *, path: Path = KB_FILE, force: bool = False) -> LoadResult:
    """以 md 为准覆盖库。三道保险见模块开头。

    只给「问法有变」的条目重算向量——别名没动就不用花钱重算，
    资料不常改（方案 §9.2），每次同步全量重算是白烧钱。
    """
    if not path.exists():
        return LoadResult(refused=f"没有找到 {path.name}，改一次标准答案（/加 或 /答）就会自动生成。")
    try:
        items = parse(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as e:
        return LoadResult(refused=f"读不了 {path.name}：{e}")

    existing = {e.id: e for e in store.entries()}
    if not items and existing:
        return LoadResult(
            refused=f"{path.name} 里一条都没解析出来，但库里有 {len(existing)} 条。"
            "为防误清空，这次什么都没改。检查一下文件内容和编码。"
        )

    keep = {i.entry_id for i in items if i.entry_id is not None}
    doomed = [eid for eid in existing if eid not in keep]
    if doomed and not force and len(doomed) > 3 and len(doomed) * 2 > len(existing):
        return LoadResult(
            refused=f"这次同步会删掉 {len(doomed)} 条（库里共 {len(existing)} 条），删得有点多。"
            "确认没问题就发「/同步 确认」。",
            needs_confirm=True,
        )

    res = LoadResult(backup=backup(store, path).name)
    for item in items:
        old = existing.get(item.entry_id) if item.entry_id is not None else None
        aliases = "\n".join(item.aliases)
        if old is not None and old.question == item.question and old.answer == item.answer and old.aliases == aliases:
            res.unchanged += 1
            continue
        eid, created = store.upsert_entry(
            question=item.question, answer=item.answer, aliases=aliases, source=BY_MD, entry_id=item.entry_id
        )
        # 问法没变就不动向量。答案改了不影响检索——检索只看问法
        if created or old is None or old.question != item.question or old.aliases != aliases:
            entry = store.get_entry(eid)
            if entry is not None:
                vecs = await llm.embed(entry.phrasings)
                store.set_entry_vecs(eid, list(zip(entry.phrasings, vecs)))
        res.added += int(created)
        res.updated += int(not created)

    for eid in doomed:
        if store.delete_entry(eid):
            res.deleted += 1

    # 回写一遍，给手写的新条目补上编号。手改内容刚进库，不算「未同步」，
    # 所以这次不留手改备份（见 write 的 keep_handedit）
    write(store, path, keep_handedit=False)
    log.info("知识库同步：%s（备份 %s）", res.summary(), res.backup)
    return res
