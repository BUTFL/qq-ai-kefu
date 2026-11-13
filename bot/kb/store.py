"""AI 问答的存储。SQLite，标准库 sqlite3。

**故意用新库 data/qa.db，不往 approvals.db 里加表。** 入群审批已经正式生效、
天天在写真实数据，问答是新功能还要反复改表结构。分开放的话，问答这边
删库重建随时能干，不会碰到已上线功能的留痕数据。

和 bot/store.py 的两处不同，都是被这个场景逼出来的：

1. `check_same_thread=False` + 一把锁。向量检索是纯 Python 计算（上千个
   1024 维点积），跑在事件循环里会把整个机器人卡住——收不到消息也回不了话。
   所以检索整段包在 asyncio.to_thread 里，连接就会被别的线程碰到。
2. 建了 FTS5 索引。理由见 text.py 顶部：中文关键词检索不能用 trigram。

向量存成 float32 BLOB。入库前已经归一化成单位向量，所以检索时余弦相似度
就是点积，省掉每次算模长（归一化在 llm.py 里做）。
"""
from __future__ import annotations

import array
import json
import logging
import re
import sqlite3
import threading
from collections import Counter
from collections.abc import Iterable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from . import text as textutil

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = ROOT / "data" / "qa.db"
# 标准答案附图的文件（后台上传的），库里 kb_images 只记文件名
KB_IMAGE_DIR = ROOT / "data" / "kb_images"

# 像「第2步：填写 API 信息」这种步骤小标题，不是主题（见 KBStore.topics）
_JUNK_TITLE = re.compile(r"[：:，,。]|^第|^\d|完整文档")

# 一条回答是怎么来的。日报按这个分类统计，也是排查「它为什么这么答」的第一线索
SRC_KB = "kb"  # 命中你定过的标准答案
SRC_RAG = "rag"  # 查资料答的
SRC_MISS = "miss"  # 资料里没有，回了固定话术（没硬编）
SRC_ERROR = "error"  # 调中转站出错
# 直接转人工，AI 全程没参与。**三道闸共用这一个源**：提到退款、客户点名要人工、
# 沾价格（见 bot/handlers/qa.py）。对账上它们是一回事 ——「这件事落到人头上了」，
# 所以 day_stats() 一个字都不用动。要拆开看是哪一道，查 qa_log.answer 列
SRC_HUMAN = "human"
# 寒暄。**故意不算进 day_stats 的 total**：算进去命中率的分母就被「你好」灌水了，
# 而命中率是用来看「标准答案盖住了多少真问题」的。它也不生成问题类（cluster），
# 不然待办会被打招呼刷满 —— 那正是 2026-09-23 要做闲聊模式的起因
SRC_CHAT = "chat"
# 碰了不聊的话题（黄赌毒政，见 bot/guard.py），回了固定话术，AI 全程没参与。
# **跟 chat 一样不进 total、不进 avg_ms**：它不是「问了个业务问题没答上来」，
# 算进分母会让命中率无缘无故变难看。
# 也**不生成 cluster** —— 红线话题进待办，等于催着你给它定一个标准答案
SRC_BLOCK = "block"
# 人工接管期间客户 @我，回了那句「稍等」（阶段 6，见 bot/handoff.py）。
# **跟 chat、block 同等对待：不进 total、不进 avg_ms。** 接管期间被 @ 一次
# 就算一问的话，命中率被稀释、平均耗时被零耗时的安抚话术冲淡，日报读着像
# 机器人变笨了 —— 数字虚高比没有数字更糟，没有数字他会去查，虚高他会直接信。
# **也不能复用 human**：那个数字的意思是「今天转了几次人工」，每被 @ 一次就 +1 是虚报
SRC_HOLDING = "holding"
# 照 /口径 的原话回的（bot/kb/notice.py，2026-09-30 加的）。**算进 total**：客户问了真问题、也答了，
# 只是答的是临时口径，不是标准答案也不是资料
SRC_NOTICE = "notice"
# 照管理员以前在群里怎么回的、原话回的（bot/kb/memory.py，2026-10-15）。算进 total
SRC_MEMORY = "memory"
SRC_CN = {
    SRC_KB: "标准答案", SRC_RAG: "查资料", SRC_MISS: "答不上来",
    SRC_ERROR: "出错", SRC_HUMAN: "转人工", SRC_CHAT: "寒暄",
    SRC_BLOCK: "不聊的话题", SRC_HOLDING: "接管中安抚", SRC_NOTICE: "照口径答",
    SRC_MEMORY: "照管理员答过的",
}

# 转人工会话的三个状态。**没有行 = AI 在管**，所以没有「AI 接管」这个值。
# 只有 HO_TAKEN 让机器人闭嘴；等人工期间照常答题（规矩见 bot/handoff.py 开头）
HO_WAITING = "waiting"  # 已经私聊叫人了，人还没来
HO_TAKEN = "taken"  # 人来了，机器人只回「稍等」那句
HO_ENDED = "ended"  # 交还给 AI：超管发 /结束，或者一天没动静自动关（ended_by=0），见 bot/handoff.py
HO_OPEN = (HO_WAITING, HO_TAKEN)

# 标准答案的来源
BY_QQ = "qq"  # 群里发指令定的
BY_MD = "md"  # 从 知识库.md 反向加载的
BY_LEARN = "learn"  # 夜间复盘起草、你审过才进来的（bot/kb/review.py）

# 群消息里说话的人。**只有 STAFF 的话能当答案来源**，客户互相回答的只用来发现问题
ROLE_CUSTOMER = "customer"
ROLE_STAFF = "staff"

# 复盘草稿。**待审的永远不进检索**，你点了「采纳」才变成标准答案
DR_PENDING = "pending"
DR_ACCEPTED = "accepted"
DR_REJECTED = "rejected"
DR_NEW = "new"  # 新的一条标准答案
DR_ALIAS = "alias"  # 已有答案认得的问法不够，把客户的说法加成别名
# 两条标准答案其实是一件事（2026-09-29 他选的 8A）。entry_id = 留下的那条，merge_from = 要并掉的那条，
# answer / options = 合并后的几种说法。采纳 = 留下那条换成选的说法、问法并过去、问题类和附图挪过去、删掉另一条
DR_MERGE = "merge"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 导入过的资料文件。sha1 没变就不重新切块、不重新花钱算向量
CREATE TABLE IF NOT EXISTS docs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT    NOT NULL UNIQUE,
    sha1        TEXT    NOT NULL,
    chars       INTEGER NOT NULL DEFAULT 0,
    n_chunks    INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    seq    INTEGER NOT NULL,
    title  TEXT    NOT NULL DEFAULT '',
    body   TEXT    NOT NULL,
    -- 这一块出自哪个网页。灵眸文档的 llms-full.txt 每页带一行 URL:，
    -- 带上它回答才能给真链接，客户能自己点过去核对
    url    TEXT    NOT NULL DEFAULT '',
    vec    BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

-- 你定过的标准答案。命中这里 = 不用查资料、不用赌模型
CREATE TABLE IF NOT EXISTS kb_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    question   TEXT    NOT NULL,
    answer     TEXT    NOT NULL,
    aliases    TEXT    NOT NULL DEFAULT '',  -- 换行分隔的其它问法
    hits       INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    source     TEXT    NOT NULL DEFAULT 'qq'
);

-- 一条答案的每个问法各存一个向量，检索时取最大分。
-- 不把多个问法的向量求平均——平均会把两种问法都拉偏，谁都不像
CREATE TABLE IF NOT EXISTS kb_vecs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id  INTEGER NOT NULL REFERENCES kb_entries(id) ON DELETE CASCADE,
    phrasing  TEXT    NOT NULL,
    vec       BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_vecs_entry ON kb_vecs(entry_id);

-- 把「怎么退款」「咋退钱」「退款流程」这些归成一个问题，日报才数得准
CREATE TABLE IF NOT EXISTS clusters (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    label    TEXT    NOT NULL,
    vec      BLOB    NOT NULL,
    asked    INTEGER NOT NULL DEFAULT 0,
    entry_id INTEGER REFERENCES kb_entries(id) ON DELETE SET NULL,
    resolved INTEGER NOT NULL DEFAULT 0,  -- 你说过「这个不用答」也算处理完
    first_at TEXT    NOT NULL,
    last_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clusters_open ON clusters(resolved, asked);

-- 每问每答的流水。「边答边写文档」就靠这张表，日报和待办也都从这里出
CREATE TABLE IF NOT EXISTS qa_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL DEFAULT 0,
    user_id    INTEGER NOT NULL DEFAULT 0,
    nickname   TEXT    NOT NULL DEFAULT '',
    question   TEXT    NOT NULL,
    answer     TEXT    NOT NULL DEFAULT '',
    source     TEXT    NOT NULL,
    score      REAL    NOT NULL DEFAULT 0,
    entry_id   INTEGER,
    cluster_id INTEGER,
    rewritten  INTEGER NOT NULL DEFAULT 0,  -- 重写后的版本有没有真发出去
    faithful   INTEGER,                      -- 自检结论：1 过 / 0 没过（退回原文）
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_log_at ON qa_log(created_at);
CREATE INDEX IF NOT EXISTS idx_qa_log_cluster ON qa_log(cluster_id);

-- 转人工会话。**一次转人工一行，结束了不删**，留着就是会话档案（方案 #51）。
-- 同一个客户在同一个群里同时最多开一个：靠下面那条部分唯一索引，
-- 不靠代码里先查再插（两个 handler 并发跑，先查再插挡不住）
CREATE TABLE IF NOT EXISTS handoffs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    nickname   TEXT    NOT NULL DEFAULT '',
    question   TEXT    NOT NULL DEFAULT '',  -- 触发转人工的那句原话
    reason     TEXT    NOT NULL,             -- human / refund / price / invoice / miss / crisis
    state      TEXT    NOT NULL,             -- waiting / taken / ended
    taken_by   INTEGER,
    ended_by   INTEGER,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_handoffs_open
    ON handoffs(group_id, user_id) WHERE state IN ('waiting', 'taken');
CREATE INDEX IF NOT EXISTS idx_handoffs_state ON handoffs(state, group_id);

-- 标准答案附带的图片。命中答案时文字发完接着发图。
-- 文件存在 data/kb_images/，这里只记文件名。答案删了图片行跟着删（CASCADE）
CREATE TABLE IF NOT EXISTS kb_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id   INTEGER NOT NULL REFERENCES kb_entries(id) ON DELETE CASCADE,
    file       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_images_entry ON kb_images(entry_id);

-- 群里的每一条消息（不管 @ 没 @ 我），夜间复盘的原料。
-- **只留一天**（2026-09-28 管理员定的「存 1 天，复习完就删」）：每晚 23:00 复盘跑完
-- 就删掉复盘开始之前的所有行，复盘没跑成（中转站挂了）也会删掉 36 小时前的，不会越攒越多。
-- 学到的东西落在 kb_drafts / qa_log 里，这张表本身不是档案
CREATE TABLE IF NOT EXISTS group_msgs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    nickname   TEXT    NOT NULL DEFAULT '',
    role       TEXT    NOT NULL,             -- customer / staff
    message_id INTEGER NOT NULL DEFAULT 0,
    reply_to   INTEGER NOT NULL DEFAULT 0,   -- 引用回复的那条 message_id，没有 = 0
    at_me      INTEGER NOT NULL DEFAULT 0,
    body       TEXT    NOT NULL,             -- 只存文字，图片记成「[图片]」
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_msgs_at ON group_msgs(group_id, created_at);

-- 夜间复盘起草的东西，等你审。**永不直接进检索**：采纳了才写进 kb_entries。
-- 每条都带 evidence（从哪几条群消息 / 哪次问答来的），审的时候看得到原话
CREATE TABLE IF NOT EXISTS kb_drafts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,             -- new（新答案）/ alias（给已有答案加问法）
    entry_id   INTEGER REFERENCES kb_entries(id) ON DELETE CASCADE,  -- alias 才有
    cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
    question   TEXT    NOT NULL,
    aliases    TEXT    NOT NULL DEFAULT '',
    answer     TEXT    NOT NULL DEFAULT '',
    evidence   TEXT    NOT NULL DEFAULT '',  -- 人读的原话摘录，一行一条
    note       TEXT    NOT NULL DEFAULT '',  -- 复盘写的「为什么起这条草稿」
    state      TEXT    NOT NULL DEFAULT 'pending',
    decided_by INTEGER,
    created_at TEXT    NOT NULL,
    decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_drafts_state ON kb_drafts(state, id);

-- 每晚复盘一行：跑了没、花了多少、结论是什么。日报从这里取「今晚复盘」那段
-- 谁定了 / 改了 / 删了哪条标准答案（2026-09-29 他选的 10A：复盘里列今天谁定了哪几条）。
-- who 是 QQ 号（6099 页面上改的记 0 —— 页面只认 6099 的密码，不知道是谁在点），name 是当时的群名片
CREATE TABLE IF NOT EXISTS kb_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT    NOT NULL,             -- 定 / 改 / 删 / 采纳 / 合并
    entry_id   INTEGER,
    question   TEXT    NOT NULL DEFAULT '',
    who        INTEGER NOT NULL DEFAULT 0,
    name       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_audit_at ON kb_audit(created_at);

-- 顺着网址爬常见问题（bot/kb/crawl.py，2026-09-29）。一次爬一行，进度页面轮询这张表
CREATE TABLE IF NOT EXISTS crawl_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    NOT NULL,
    state       TEXT    NOT NULL,             -- running / done / stopped / failed
    max_pages   INTEGER NOT NULL,
    pages       INTEGER NOT NULL DEFAULT 0,   -- 看了几页
    found       INTEGER NOT NULL DEFAULT 0,   -- 找到几条问答
    drafts      INTEGER NOT NULL DEFAULT 0,   -- 进了几条草稿（去掉跟已有答案、已有草稿重复的）
    images      INTEGER NOT NULL DEFAULT 0,
    replaced    TEXT    NOT NULL DEFAULT '',  -- 换掉的别家平台，逗号分隔
    log         TEXT    NOT NULL DEFAULT '',  -- 最近几行进度，给页面看
    error       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    finished_at TEXT
);
-- 草稿带的图（爬来的截图）。采纳时挪成标准答案的附图（kb_images），不要就连文件一起删
CREATE TABLE IF NOT EXISTS kb_draft_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id   INTEGER NOT NULL REFERENCES kb_drafts(id) ON DELETE CASCADE,
    file       TEXT    NOT NULL,             -- data/kb_images/ 下的文件名，跟标准答案附图同一个目录
    caption    TEXT    NOT NULL DEFAULT '',  -- 看图模型说图里是什么
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_draft_images ON kb_draft_images(draft_id);

CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    day         TEXT    NOT NULL,
    started_at  TEXT    NOT NULL,
    finished_at TEXT,
    ok          INTEGER NOT NULL DEFAULT 0,
    llm_calls   INTEGER NOT NULL DEFAULT 0,
    tokens      INTEGER NOT NULL DEFAULT 0,
    summary     TEXT    NOT NULL DEFAULT '',  -- 发进日报的那段
    error       TEXT    NOT NULL DEFAULT ''
);

-- 机器人自己琢磨出来的「规律」（夜间复盘最后一步写的，见 bot/kb/review.py）。
-- **只给你看，永远不进回答**：它是「你可能要注意的事」，不是事实。
-- 每条都得指着当天材料里的具体条目（evidence），指不出来的不收 —— 不许凭空想。
-- 相似的并成一条、seen+1：同一件事连着几天都冒出来，才值得你花时间
CREATE TABLE IF NOT EXISTS lessons (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    text     TEXT    NOT NULL,
    vec      BLOB    NOT NULL,
    evidence TEXT    NOT NULL DEFAULT '',   -- 最近一次冒出来时依据的那几条材料
    seen     INTEGER NOT NULL DEFAULT 1,    -- 在几个晚上冒出来过
    state    TEXT    NOT NULL DEFAULT 'active',  -- active / dismissed（你说不用管了）
    first_at TEXT    NOT NULL,
    last_at  TEXT    NOT NULL
);

-- 自己人名单：这些 QQ 号在群里说的话，夜间复盘当成「人工客服的答法」来学。
-- **超管（SUPER_ADMINS）不在这张表里也算**，这张表是额外加的同事。
-- 放库里不放 .env：.env 在容器里是只读挂载，改了还得重启机器人；这张表在 6099 页面上
-- 加一行，下一条群消息就按新名单判（2026-09-28 管理员要的「弄一个列表让我自己添加」）
CREATE TABLE IF NOT EXISTS trusted (
    user_id    INTEGER PRIMARY KEY,
    note       TEXT    NOT NULL DEFAULT '',  -- 这人是谁，给你自己看
    created_at TEXT    NOT NULL
);

-- 管理员 / 同事在群里怎么回客户的（bot/kb/memory.py，2026-10-15）。机器人自己学、自己用：
-- 没 @ 我的问题像到 MEMORY_SCORE 就照原话回；@ 我的问题拿它当参照。/记忆 看、/忘 编号 删
CREATE TABLE IF NOT EXISTS staff_memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL DEFAULT 0,
    question   TEXT    NOT NULL,
    answer     TEXT    NOT NULL,
    staff_id   INTEGER NOT NULL DEFAULT 0,
    staff_name TEXT    NOT NULL DEFAULT '',
    vec        BLOB    NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

-- 关键词索引。rowid 对齐 chunks.id / kb_entries.id，存的是 text.grams() 切好的 2-gram
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(toks, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts     USING fts5(toks, tokenize='unicode61');
"""


def pack(vec: Sequence[float]) -> bytes:
    return array.array("f", vec).tobytes()


def unpack(blob: bytes) -> array.array:
    out = array.array("f")
    out.frombytes(blob)
    return out


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _merge_aliases(old: str, new: str, question: str) -> str:
    """老别名 + 新别名，去重保序，去掉和标准问法重复的那条。

    **这是补一次真实的数据丢失。** 2026-09-23 18:30:11 管理员对着 #36 发了
    `/答`，那一类底下四条流水是一模一样的一句话，`others` 算出来是空的，
    于是 `aliases=""` 把他 14:23 亲手在知识库.md 里加的三个问法
    （显示地区不可用 / 地区不可用 / 提示所在地区不可用）连同向量一起冲掉了——
    库里「认得几种问法」从 10 掉到 7，`显示地区不可用` 这句从命中标准答案
    （1.000）掉成查资料（0.523）。**整个过程没有任何提示**，他四分钟后就在群里
    说了那句「万一别人不那么问的呢」，说的正是这件事。

    所以 `/答` 这条路上别名只增不减：客户每换一种问法都是白捡的真实语料，
    再答一次答案是「把话说得更准」，不该顺手把问法认知抹掉。
    要删问法有明路——改知识库.md 再 /同步，那条路是全量覆盖（见 upsert_entry）。
    """
    seen: dict[str, None] = {}
    for line in (*old.splitlines(), *new.splitlines()):
        a = line.strip()
        if a and a != question:
            seen[a] = None
    return "\n".join(seen)


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


@dataclass(frozen=True)
class Entry:
    id: int
    question: str
    answer: str
    aliases: str
    hits: int
    created_by: int | None
    created_at: str
    updated_at: str
    source: str

    @property
    def phrasings(self) -> list[str]:
        """标准问法 + 所有别名问法。每个都要单独算向量。"""
        extra = [a.strip() for a in self.aliases.splitlines() if a.strip()]
        return [self.question, *extra]


@dataclass(frozen=True)
class Cluster:
    id: int
    label: str
    asked: int
    entry_id: int | None
    resolved: int
    first_at: str
    last_at: str

    @property
    def answered(self) -> bool:
        return self.entry_id is not None


@dataclass(frozen=True)
class DocRow:
    path: str
    chars: int
    n_chunks: int
    imported_at: str


@dataclass(frozen=True)
class HandoffRow:
    id: int
    group_id: int
    user_id: int
    nickname: str
    question: str
    reason: str
    state: str
    taken_by: int | None
    ended_by: int | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class DayStats:
    total: int = 0
    kb: int = 0
    rag: int = 0
    miss: int = 0
    error: int = 0
    human: int = 0  # 退款这类直接转人工的
    chat: int = 0  # 寒暄。**不在 total 里面**，理由见 SRC_CHAT
    blocked: int = 0  # 碰红线被挡的。**也不在 total 里面**，理由见 SRC_BLOCK
    holding: int = 0  # 人工接管期间回的「稍等」。**也不在 total 里面**，理由见 SRC_HOLDING
    notice: int = 0  # 照 /口径 原话回的。在 total 里面，理由见 SRC_NOTICE
    rewrite_kept: int = 0  # 重写通过自检，发的是重写版
    rewrite_fellback: int = 0  # 自检没过，退回了标准答案原文
    avg_ms: int = 0

    @property
    def kb_rate(self) -> int:
        return round(self.kb * 100 / self.total) if self.total else 0


# 老库补列。`CREATE TABLE IF NOT EXISTS` 不会给已有的表加列，线上 qa.db 是 09-22 建的
_MIGRATIONS = (
    # 这次回答用了哪几块资料（逗号分隔的 chunks.id）。夜间复盘逐句对照要用，
    # 事后查「它为什么这么答」也靠它。**只记 id 不记正文**：资料重新导入后 id 会变，
    # 对不上就当没记，不影响回答
    ("qa_log", "chunk_ids", "TEXT NOT NULL DEFAULT ''"),
    # 夜间复盘对这条回答的结论：''（没查）/ ok / unsupported（有资料里没有的说法）
    ("qa_log", "audit", "TEXT NOT NULL DEFAULT ''"),
    ("qa_log", "audit_note", "TEXT NOT NULL DEFAULT ''"),
    # 客户答完之后说了什么「不对 / 没用 / 还是不行」，原话记这里。空 = 没说
    ("qa_log", "feedback", "TEXT NOT NULL DEFAULT ''"),
    # 人工答法草稿的几种说法（JSON 数组，每项 {"label": "贴近原话", "answer": "…"}）。
    # 2026-09-29 管理员要的「不一定按照我的文字，你自己整理一下给我几个选择让我去选」。
    # `answer` 列还是第一种（选项读不出来时照旧能用）
    ("kb_drafts", "options", "TEXT NOT NULL DEFAULT ''"),
    # 爬到哪儿了：看过的网址、还没爬的队列。**为了「接着爬」**（2026-10-08 他要的）——
    # 以前这两样只在内存里，停了或者机器人重启就全丢，重新开等于从头再爬一遍几十页。
    # 存成一行一条：seen 是网址，queue 是「优先级\t深度\t网址」
    ("crawl_jobs", "seen", "TEXT NOT NULL DEFAULT ''"),
    ("crawl_jobs", "queue", "TEXT NOT NULL DEFAULT ''"),
    # 合并草稿（DR_MERGE）要并掉的那条答案
    ("kb_drafts", "merge_from", "INTEGER"),
    # 爬常见问题起的草稿：从哪一页来的（页面上点得开对照）、哪次爬的
    ("kb_drafts", "source_url", "TEXT NOT NULL DEFAULT ''"),
    ("kb_drafts", "crawl_id", "INTEGER"),
)


class KBStore:
    def __init__(self, path: Path = DB_PATH) -> None:
        # 自己是哪个库文件（sync.write 靠它认「临时库别往真文件写」，见那里的硬保险）
        self.path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        # 2026-10-18 补：qa.db 在 10-16 部署重启时被写坏过（rollback journal 恢复失败，
        # clusters 表页损坏，客户提问全线崩）。WAL 的主库文件永远一致，写入被砍断
        # 最多丢最后没提交的那一笔，不会再坏页；busy_timeout 让真撞上的写等 5 秒再报错
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        for table, col, decl in _MIGRATIONS:
            have = {r["name"] for r in self._db.execute(f"PRAGMA table_info({table})")}
            if col not in have:
                self._db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        self._db.commit()
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """所有读写都走这里。一把粗锁够用：检索在工作线程、写入在事件循环，
        两边都是毫秒级，争抢概率极低，细粒度锁不值得。"""
        with self._lock:
            try:
                yield self._db
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

    # ---- 版本号：检索层拿它判断内存里的向量缓存要不要重建 ----

    def revision(self) -> int:
        with self._tx() as db:
            row = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()
            return int(row["value"]) if row else 0

    def _bump(self, db: sqlite3.Connection) -> None:
        db.execute(
            "INSERT INTO meta(key, value) VALUES('revision', '1')"
            " ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
        )

    # ---- meta 表的通用读写 ----
    # `revision` 单独有方法是因为它要在同一个事务里 +1（见 _bump）。
    # 这两个是给「记一个小标记，下次回来对一下」用的，第一个用户是
    # bot/kb/sync.py 的 write()：记下上次导出的指纹，用来认出文件被手改过

    def get_meta(self, key: str) -> str | None:
        with self._tx() as db:
            row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._tx() as db:
            db.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    # ---- 资料 ----

    def doc_sha1(self, path: str) -> str | None:
        with self._tx() as db:
            row = db.execute("SELECT sha1 FROM docs WHERE path=?", (path,)).fetchone()
            return row["sha1"] if row else None

    def replace_doc(
        self, path: str, sha1: str, chars: int, blocks: Iterable[tuple[str, str, str, Sequence[float]]]
    ) -> int:
        """整份文件重新入库：旧切块连 FTS 一起删干净，再插新的。

        没做「只更新变动的块」——资料不常改（方案 §9.2），全量重算一份文件
        的向量也就几秒，而增量 diff 的复杂度和出错面大得多。
        """
        with self._tx() as db:
            old = db.execute("SELECT id FROM docs WHERE path=?", (path,)).fetchone()
            if old:
                ids = [r["id"] for r in db.execute("SELECT id FROM chunks WHERE doc_id=?", (old["id"],))]
                db.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(i,) for i in ids])
                db.execute("DELETE FROM chunks WHERE doc_id=?", (old["id"],))
                db.execute("DELETE FROM docs WHERE id=?", (old["id"],))
            cur = db.execute(
                "INSERT INTO docs(path, sha1, chars, n_chunks, imported_at) VALUES (?,?,?,?,?)",
                (path, sha1, chars, 0, _now()),
            )
            doc_id = int(cur.lastrowid or 0)
            n = 0
            for seq, (title, body, url, vec) in enumerate(blocks):
                c = db.execute(
                    "INSERT INTO chunks(doc_id, seq, title, body, url, vec) VALUES (?,?,?,?,?,?)",
                    (doc_id, seq, title, body, url, pack(vec)),
                )
                db.execute(
                    "INSERT INTO chunks_fts(rowid, toks) VALUES (?,?)",
                    (int(c.lastrowid or 0), " ".join(textutil.grams(f"{title}\n{body}"))),
                )
                n += 1
            db.execute("UPDATE docs SET n_chunks=? WHERE id=?", (n, doc_id))
            self._bump(db)
            return n

    def drop_docs_except(self, keep: Iterable[str]) -> list[str]:
        """资料目录里已经删掉的文件，库里也清掉。返回清掉的路径。

        不做这一步的话，你删了一份过期的价格表，机器人还在照它回答。
        """
        keep = set(keep)
        with self._tx() as db:
            gone = [r["path"] for r in db.execute("SELECT path FROM docs") if r["path"] not in keep]
            for path in gone:
                row = db.execute("SELECT id FROM docs WHERE path=?", (path,)).fetchone()
                ids = [r["id"] for r in db.execute("SELECT id FROM chunks WHERE doc_id=?", (row["id"],))]
                db.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(i,) for i in ids])
                db.execute("DELETE FROM chunks WHERE doc_id=?", (row["id"],))
                db.execute("DELETE FROM docs WHERE id=?", (row["id"],))
            if gone:
                self._bump(db)
            return gone

    def drop_doc(self, path: str) -> bool:
        """删掉一份资料（后台「删除资料」用）。"""
        with self._tx() as db:
            row = db.execute("SELECT id FROM docs WHERE path=?", (path,)).fetchone()
            if not row:
                return False
            ids = [r["id"] for r in db.execute("SELECT id FROM chunks WHERE doc_id=?", (row["id"],))]
            db.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(i,) for i in ids])
            db.execute("DELETE FROM chunks WHERE doc_id=?", (row["id"],))
            db.execute("DELETE FROM docs WHERE id=?", (row["id"],))
            self._bump(db)
            return True

    def doc_chunks(self, path: str, limit: int = 200) -> list[tuple[str, str]]:
        """一份资料切出来的块 [(标题, 正文)]，后台预览用。"""
        with self._tx() as db:
            rows = db.execute(
                "SELECT c.title, c.body FROM chunks c JOIN docs d ON d.id = c.doc_id"
                " WHERE d.path=? ORDER BY c.seq LIMIT ?",
                (path, limit),
            ).fetchall()
            return [(r["title"], r["body"]) for r in rows]

    def docs(self) -> list[DocRow]:
        with self._tx() as db:
            rows = db.execute("SELECT path, chars, n_chunks, imported_at FROM docs ORDER BY path").fetchall()
            return [DocRow(**dict(r)) for r in rows]

    def chunk_count(self) -> int:
        with self._tx() as db:
            return int(db.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"])

    def topics(self, limit: int = 28) -> list[str]:
        """资料覆盖的主题，内容多的排前面。

        **只给「你会什么」那类问题当底稿用，不参与检索。** 2026-09-23 管理员定的：
        自我介绍要「从文档查一下再结合 AI 说一句」，不是让模型凭空编一份功能清单 ——
        编出来的功能客户当真去用，那是最难收回的一类错。

        取标题的第一段（`Chatbox › 第2步：填写 API 信息` → `Chatbox`）。抓下来的
        文档里混着纯步骤标题（「显示版本号表示安装成功」），这里只做粗筛：带冒号
        逗号的、「第…」开头的、太长的扔掉。**筛太狠会把「Claude Code 桌面版」
        这种真主题一起筛掉**，剩下的噪音交给模型自己忽略（提示词里写了）。
        """
        with self._tx() as db:
            rows = db.execute("SELECT title FROM chunks WHERE title <> ''").fetchall()
        seen: Counter[str] = Counter()
        for r in rows:
            head = r["title"].split("›")[0].strip()
            if not head or len(head) > 16 or _JUNK_TITLE.search(head):
                continue
            seen[head] += 1
        return [name for name, n in seen.most_common(limit * 2) if n >= 3][:limit]

    # ---- 检索用的读取 ----

    def chunk_vecs(self) -> list[tuple[int, array.array]]:
        with self._tx() as db:
            rows = db.execute("SELECT id, vec FROM chunks WHERE vec IS NOT NULL").fetchall()
            return [(r["id"], unpack(r["vec"])) for r in rows]

    def entry_vecs(self) -> list[tuple[int, str, array.array]]:
        with self._tx() as db:
            rows = db.execute("SELECT entry_id, phrasing, vec FROM kb_vecs").fetchall()
            return [(r["entry_id"], r["phrasing"], unpack(r["vec"])) for r in rows]

    def fts_search(self, table: str, question: str, limit: int = 20) -> dict[int, float]:
        """关键词检索，返回 {rowid: 归一化到 0~1 的分}。

        bm25() 返回的是负数（越小越相关），直接和余弦相似度混合没法比较，
        所以取最佳分做线性归一：最相关的那条是 1.0，其余按比例。
        这只是给混合检索当一路信号用，不需要绝对可比。
        """
        if table not in {"chunks_fts", "kb_fts"}:
            raise ValueError(f"未知的索引表 {table!r}")
        expr = textutil.fts_query(question)
        if not expr:
            return {}
        with self._tx() as db:
            try:
                rows = db.execute(
                    f"SELECT rowid, bm25({table}) AS s FROM {table} WHERE {table} MATCH ?"
                    " ORDER BY s LIMIT ?",
                    (expr, limit),
                ).fetchall()
            except sqlite3.OperationalError as e:
                # 理论上 fts_query 已经把语法字符都引号包住了，真出了就记下来别把问答打断
                log.warning("关键词检索失败（降级为纯向量）: %s | 表达式 %.120s", e, expr)
                return {}
        if not rows:
            return {}
        best = min(r["s"] for r in rows) or -1e-9
        return {int(r["rowid"]): max(0.0, min(1.0, r["s"] / best)) for r in rows}

    def chunks_by_ids(self, ids: Iterable[int]) -> dict[int, tuple[str, str, str]]:
        """{id: (标题, 正文, 出处链接)}。链接可能是空串——不是每页都有 URL 行。"""
        ids = list(ids)
        if not ids:
            return {}
        qs = ",".join("?" * len(ids))
        with self._tx() as db:
            rows = db.execute(f"SELECT id, title, body, url FROM chunks WHERE id IN ({qs})", ids).fetchall()
            return {r["id"]: (r["title"], r["body"], r["url"]) for r in rows}

    # ---- 标准答案 ----

    def upsert_entry(
        self,
        *,
        question: str,
        answer: str,
        aliases: str = "",
        by: int | None = None,
        source: str = BY_QQ,
        entry_id: int | None = None,
        merge_aliases: bool = False,
    ) -> tuple[int, bool]:
        """建或改一条答案。返回 (id, 是否新建)。

        给了 `entry_id` 就按 id 改（知识库.md 同步走这条：你在文件里改了问法，
        改的还是那一条，不能变成新增一条、旧的留着）；
        没给就按标准问法找（群里发 /答 走这条，同一个问法再答一次就是覆盖）。

        `merge_aliases=True` = 别名只增不减（`/答` 走这条，理由见 _merge_aliases）。
        知识库.md 同步**不能**开这个：那边是以文件为准的全量覆盖，
        你从文件里删掉一个问法就是要它没，合并会让它删不掉。
        """
        with self._tx() as db:
            if entry_id is not None:
                row = db.execute("SELECT id, aliases FROM kb_entries WHERE id=?", (entry_id,)).fetchone()
            else:
                row = db.execute("SELECT id, aliases FROM kb_entries WHERE question=?", (question,)).fetchone()
            if row:
                if merge_aliases:
                    aliases = _merge_aliases(row["aliases"], aliases, question)
                db.execute(
                    "UPDATE kb_entries SET question=?, answer=?, aliases=?, updated_at=?, source=? WHERE id=?",
                    (question, answer, aliases, _now(), source, row["id"]),
                )
                eid, created = int(row["id"]), False
            else:
                cur = db.execute(
                    "INSERT INTO kb_entries(question, answer, aliases, created_by, created_at, updated_at, source)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (question, answer, aliases, by, _now(), _now(), source),
                )
                eid, created = int(cur.lastrowid or 0), True
            db.execute("DELETE FROM kb_fts WHERE rowid=?", (eid,))
            db.execute(
                "INSERT INTO kb_fts(rowid, toks) VALUES (?,?)",
                (eid, " ".join(textutil.grams("\n".join([question, aliases])))),
            )
            self._bump(db)
            return eid, created

    def set_entry_vecs(self, entry_id: int, pairs: Iterable[tuple[str, Sequence[float]]]) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM kb_vecs WHERE entry_id=?", (entry_id,))
            db.executemany(
                "INSERT INTO kb_vecs(entry_id, phrasing, vec) VALUES (?,?,?)",
                [(entry_id, p, pack(v)) for p, v in pairs],
            )
            self._bump(db)

    def get_entry(self, entry_id: int) -> Entry | None:
        with self._tx() as db:
            row = db.execute("SELECT * FROM kb_entries WHERE id=?", (entry_id,)).fetchone()
            return Entry(**dict(row)) if row else None

    def entries(self) -> list[Entry]:
        with self._tx() as db:
            rows = db.execute("SELECT * FROM kb_entries ORDER BY id").fetchall()
            return [Entry(**dict(r)) for r in rows]

    def entries_by_ids(self, ids: Iterable[int]) -> dict[int, Entry]:
        ids = list(ids)
        if not ids:
            return {}
        qs = ",".join("?" * len(ids))
        with self._tx() as db:
            rows = db.execute(f"SELECT * FROM kb_entries WHERE id IN ({qs})", ids).fetchall()
            return {r["id"]: Entry(**dict(r)) for r in rows}

    def delete_entry(self, entry_id: int) -> bool:
        with self._tx() as db:
            if not db.execute("SELECT 1 FROM kb_entries WHERE id=?", (entry_id,)).fetchone():
                return False
            db.execute("DELETE FROM kb_fts WHERE rowid=?", (entry_id,))
            db.execute("DELETE FROM kb_entries WHERE id=?", (entry_id,))
            self._bump(db)
            return True

    # ---- 答案附图 ----

    def add_entry_image(self, entry_id: int, file: str) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO kb_images(entry_id, file, created_at) VALUES (?,?,?)", (entry_id, file, _now())
            )
            return int(cur.lastrowid or 0)

    def entry_images(self, entry_id: int) -> list[tuple[int, str]]:
        """[(图片 id, 文件名)]，按上传顺序。"""
        with self._tx() as db:
            rows = db.execute("SELECT id, file FROM kb_images WHERE entry_id=? ORDER BY id", (entry_id,)).fetchall()
            return [(r["id"], r["file"]) for r in rows]

    def all_entry_images(self) -> dict[int, list[tuple[int, str]]]:
        with self._tx() as db:
            out: dict[int, list[tuple[int, str]]] = {}
            for r in db.execute("SELECT id, entry_id, file FROM kb_images ORDER BY id"):
                out.setdefault(r["entry_id"], []).append((r["id"], r["file"]))
            return out

    def get_image(self, image_id: int) -> str | None:
        with self._tx() as db:
            row = db.execute("SELECT file FROM kb_images WHERE id=?", (image_id,)).fetchone()
            return row["file"] if row else None

    def delete_image(self, image_id: int) -> str | None:
        """删一张附图，返回文件名让调用方删文件。"""
        with self._tx() as db:
            row = db.execute("SELECT file FROM kb_images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return None
            db.execute("DELETE FROM kb_images WHERE id=?", (image_id,))
            return row["file"]

    def bump_hit(self, entry_id: int) -> None:
        with self._tx() as db:
            db.execute("UPDATE kb_entries SET hits = hits + 1 WHERE id=?", (entry_id,))

    def entry_count(self) -> int:
        with self._tx() as db:
            return int(db.execute("SELECT COUNT(*) c FROM kb_entries").fetchone()["c"])

    # ---- 问题归并 ----

    def cluster_vecs(self) -> list[tuple[int, array.array]]:
        with self._tx() as db:
            rows = db.execute("SELECT id, vec FROM clusters").fetchall()
            return [(r["id"], unpack(r["vec"])) for r in rows]

    def new_cluster(self, label: str, vec: Sequence[float]) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO clusters(label, vec, asked, first_at, last_at) VALUES (?,?,1,?,?)",
                (label, pack(vec), _now(), _now()),
            )
            return int(cur.lastrowid or 0)

    def touch_cluster(self, cluster_id: int) -> None:
        with self._tx() as db:
            db.execute("UPDATE clusters SET asked = asked + 1, last_at=? WHERE id=?", (_now(), cluster_id))

    def attach_entry(self, cluster_id: int, entry_id: int) -> None:
        with self._tx() as db:
            db.execute("UPDATE clusters SET entry_id=?, resolved=0 WHERE id=?", (entry_id, cluster_id))

    def resolve_cluster(self, cluster_id: int) -> bool:
        """标成「不用答」。和「有答案」分开记，事后能看出哪些是你主动放过的。"""
        with self._tx() as db:
            if not db.execute("SELECT 1 FROM clusters WHERE id=?", (cluster_id,)).fetchone():
                return False
            db.execute("UPDATE clusters SET resolved=1 WHERE id=?", (cluster_id,))
            return True

    def get_cluster(self, cluster_id: int) -> Cluster | None:
        with self._tx() as db:
            row = db.execute(
                "SELECT id, label, asked, entry_id, resolved, first_at, last_at FROM clusters WHERE id=?",
                (cluster_id,),
            ).fetchone()
            return Cluster(**dict(row)) if row else None

    def open_clusters(self, limit: int = 20) -> list[Cluster]:
        """等你定调的：没挂标准答案、也没被你标成不用答。问得最多的排前面。"""
        with self._tx() as db:
            rows = db.execute(
                "SELECT id, label, asked, entry_id, resolved, first_at, last_at FROM clusters"
                " WHERE entry_id IS NULL AND resolved=0 ORDER BY asked DESC, last_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [Cluster(**dict(r)) for r in rows]

    def top_clusters(self, *, since: str = "", limit: int = 10) -> list[tuple[Cluster, int]]:
        """问得最多的问题。since 给日期前缀（YYYY-MM-DD）就只统计那天。

        次数从 qa_log 现算而不是读 clusters.asked——asked 是累计值，
        日报要的是「今天问了几次」。
        """
        with self._tx() as db:
            rows = db.execute(
                "SELECT c.id, c.label, c.asked, c.entry_id, c.resolved, c.first_at, c.last_at,"
                "       COUNT(q.id) AS n"
                " FROM clusters c JOIN qa_log q ON q.cluster_id = c.id"
                " WHERE q.created_at LIKE ? GROUP BY c.id ORDER BY n DESC, c.last_at DESC LIMIT ?",
                (f"{since}%", limit),
            ).fetchall()
            return [
                (
                    Cluster(
                        id=r["id"], label=r["label"], asked=r["asked"], entry_id=r["entry_id"],
                        resolved=r["resolved"], first_at=r["first_at"], last_at=r["last_at"],
                    ),
                    int(r["n"]),
                )
                for r in rows
            ]

    def cluster_questions(self, cluster_id: int, limit: int = 3) -> list[str]:
        """这一类里实际出现过的问法，给日报展示。看得见原话才知道该怎么答。"""
        with self._tx() as db:
            rows = db.execute(
                "SELECT DISTINCT question FROM qa_log WHERE cluster_id=? ORDER BY id DESC LIMIT ?",
                (cluster_id, limit),
            ).fetchall()
            return [r["question"] for r in rows]

    # ---- 转人工会话 ----
    # 这里只管存取和「原子地换状态」。什么时候开、谁能接、接了回什么，在 bot/handoff.py

    def handoff_open(
        self, *, group_id: int, user_id: int, nickname: str, question: str, reason: str
    ) -> tuple[HandoffRow, bool]:
        """这个客户在这个群里有开着的会话就原样返回它，没有就开一个等人工的。

        返回 (会话, 是不是新开的)。**已经开着的不改原因、不改原话**：
        第一句是叫人的起因，后面再问价格也还是同一次转人工。
        """
        with self._tx() as db:
            now = _now()
            db.execute(
                "INSERT OR IGNORE INTO handoffs(group_id, user_id, nickname, question, reason, state,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (group_id, user_id, nickname, question, reason, HO_WAITING, now, now),
            )
            created = db.execute("SELECT changes() n").fetchone()["n"] > 0
            row = db.execute(
                "SELECT * FROM handoffs WHERE group_id=? AND user_id=? AND state IN (?,?)",
                (group_id, user_id, *HO_OPEN),
            ).fetchone()
            return HandoffRow(**dict(row)), created

    def handoff_state(self, group_id: int, user_id: int) -> str | None:
        """这个客户现在的状态。没有开着的会话 = None = AI 在管。"""
        with self._tx() as db:
            row = db.execute(
                "SELECT state FROM handoffs WHERE group_id=? AND user_id=? AND state IN (?,?)",
                (group_id, user_id, *HO_OPEN),
            ).fetchone()
            return row["state"] if row else None

    def handoff_get(self, handoff_id: int) -> HandoffRow | None:
        with self._tx() as db:
            row = db.execute("SELECT * FROM handoffs WHERE id=?", (handoff_id,)).fetchone()
            return HandoffRow(**dict(row)) if row else None

    def handoffs_open(self, group_id: int | None = None) -> list[HandoffRow]:
        """开着的会话，老的在前。给 None 就是全部群的。"""
        sql = "SELECT * FROM handoffs WHERE state IN (?,?)"
        args: list[Any] = [*HO_OPEN]
        if group_id is not None:
            sql += " AND group_id=?"
            args.append(group_id)
        with self._tx() as db:
            return [HandoffRow(**dict(r)) for r in db.execute(sql + " ORDER BY id", args)]

    def handoff_touch(self, group_id: int, user_id: int) -> None:
        """这个客户的会话有动静了（接管中他又 @我），闲置计时从现在重新算"""
        with self._tx() as db:
            db.execute(
                "UPDATE handoffs SET updated_at=? WHERE group_id=? AND user_id=? AND state IN (?,?)",
                (_now(), group_id, user_id, *HO_OPEN),
            )

    def handoff_touch_group(self, group_id: int, user_id: int | None) -> None:
        """群里有人说话。给 user_id = 这个客户自己的会话算动静；给 None（自己人说的）= 这个群里
        **被接着的**会话都算动静（同事在跟客户聊）。等人工的不算：同事在群里随便说一句不等于接了"""
        with self._tx() as db:
            if user_id is None:
                db.execute(
                    "UPDATE handoffs SET updated_at=? WHERE group_id=? AND state=?", (_now(), group_id, HO_TAKEN)
                )
            else:
                db.execute(
                    "UPDATE handoffs SET updated_at=? WHERE group_id=? AND user_id=? AND state IN (?,?)",
                    (_now(), group_id, user_id, *HO_OPEN),
                )

    def handoff_cluster(self, row: HandoffRow) -> int | None:
        """这个会话开起来之后，客户问的、现在还没定答案的那道题（待办编号）。None = 没有。

        给「会话编号」旁边配上真正该 `/答` 的那个号：09-29 同事看到「#16 bowen 答不上来」，
        顺手发了 `/答16` —— 16 是会话编号，待办 16 是另一道题（怎么联系客服），答案挂错了"""
        with self._tx() as db:
            r = db.execute(
                "SELECT q.cluster_id FROM qa_log q JOIN clusters c ON c.id = q.cluster_id"
                " WHERE q.group_id=? AND q.user_id=? AND q.created_at>=?"
                "   AND c.entry_id IS NULL AND c.resolved=0 ORDER BY q.id DESC LIMIT 1",
                (row.group_id, row.user_id, row.created_at),
            ).fetchone()
            return int(r["cluster_id"]) if r else None

    def handoff_expire(self, before: str) -> list[HandoffRow]:
        """`updated_at` 早于 before 的开着的会话全部结束（ended_by=0 = 到点自动关的），返回关掉的那些。

        查和改在同一个事务里：跟 `/结束`、自动接管并发时，以先写进去的为准，
        被那边改过的（updated_at 刷新了）这里就不会再碰。
        """
        with self._tx() as db:
            rows = [
                HandoffRow(**dict(r))
                for r in db.execute(
                    "SELECT * FROM handoffs WHERE state IN (?,?) AND updated_at < ? ORDER BY id", (*HO_OPEN, before)
                )
            ]
            now = _now()
            return [
                r for r in rows
                if db.execute(
                    "UPDATE handoffs SET state=?, ended_by=0, updated_at=? WHERE id=? AND updated_at=?",
                    (HO_ENDED, now, r.id, r.updated_at),
                ).rowcount > 0
            ]

    def handoff_move(self, handoff_id: int, *, to: str, allowed_from: Iterable[str], by: int) -> bool:
        """把会话从 allowed_from 里的某个状态换成 to。换成了返回 True。

        **检查和改写是同一条 UPDATE**：`/结束 3` 和超管在群里开口（自动接管）
        是两个并发的 handler，先读状态再写，中间就可能被另一边插一脚，
        把刚结束的会话又改回「接管中」。
        """
        src = list(allowed_from)
        col = {HO_TAKEN: "taken_by", HO_ENDED: "ended_by"}[to]  # 没有「换回等人工」这一步
        with self._tx() as db:
            cur = db.execute(
                f"UPDATE handoffs SET state=?, {col}=?, updated_at=?"
                f" WHERE id=? AND state IN ({','.join('?' * len(src))})",
                (to, by, _now(), handoff_id, *src),
            )
            return cur.rowcount > 0

    # ---- 流水 ----

    def log(
        self,
        *,
        group_id: int,
        user_id: int,
        nickname: str,
        question: str,
        answer: str,
        source: str,
        score: float = 0.0,
        entry_id: int | None = None,
        cluster_id: int | None = None,
        rewritten: bool = False,
        faithful: bool | None = None,
        elapsed_ms: int = 0,
        chunk_ids: Sequence[int] = (),
    ) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO qa_log(group_id, user_id, nickname, question, answer, source, score,"
                " entry_id, cluster_id, rewritten, faithful, elapsed_ms, chunk_ids, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    group_id, user_id, nickname, question, answer, source, score,
                    entry_id, cluster_id, int(rewritten),
                    None if faithful is None else int(faithful), elapsed_ms,
                    ",".join(str(i) for i in chunk_ids), _now(),
                ),
            )
            return int(cur.lastrowid or 0)

    def day_stats(self, day: str = "") -> DayStats:
        day = day or today()
        with self._tx() as db:
            # 寒暄、红线、接管中安抚单独数，而且不进 total、不进 avg_ms：一句「你好」
            # 现在也走模型，混进平均耗时里会把「查资料要几秒」这个数字冲淡
            # （见 SRC_CHAT、SRC_BLOCK、SRC_HOLDING）
            row = db.execute(
                "SELECT COUNT(*) rows_all, SUM(source='chat') chat,"
                " SUM(source='block') blocked, SUM(source='holding') holding,"
                " SUM(source='kb') kb, SUM(source='rag') rag,"
                " SUM(source='miss') miss, SUM(source='error') error,"
                " SUM(source='human') human, SUM(source='notice') notice,"
                " SUM(source='kb' AND rewritten=1) rk,"
                " SUM(source='kb' AND faithful=0) rf,"
                " AVG(CASE WHEN source NOT IN ('chat','block','holding') THEN elapsed_ms END) ms"
                " FROM qa_log WHERE created_at LIKE ?",
                (f"{day}%",),
            ).fetchone()
        chat = int(row["chat"] or 0)
        blocked = int(row["blocked"] or 0)
        holding = int(row["holding"] or 0)
        total = int(row["rows_all"] or 0) - chat - blocked - holding
        if not total:
            # 今天只有寒暄/红线/安抚也要把这几个数带出去，不然日报会说「今天没人提问」
            return DayStats(chat=chat, blocked=blocked, holding=holding)
        return DayStats(
            total=total,
            kb=int(row["kb"] or 0),
            rag=int(row["rag"] or 0),
            miss=int(row["miss"] or 0),
            error=int(row["error"] or 0),
            human=int(row["human"] or 0),
            notice=int(row["notice"] or 0),
            chat=chat,
            blocked=blocked,
            holding=holding,
            rewrite_kept=int(row["rk"] or 0),
            rewrite_fellback=int(row["rf"] or 0),
            avg_ms=int(row["ms"] or 0),
        )

    def unanswered_today(self, day: str = "", limit: int = 10) -> list[tuple[str, int]]:
        """今天答不上来的问题原话。日报里直接列出来给你定调。"""
        day = day or today()
        with self._tx() as db:
            rows = db.execute(
                "SELECT question, COUNT(*) n FROM qa_log"
                " WHERE created_at LIKE ? AND source IN ('miss','error')"
                " GROUP BY question ORDER BY n DESC LIMIT ?",
                (f"{day}%", limit),
            ).fetchall()
            return [(r["question"], int(r["n"])) for r in rows]

    def stats_line(self) -> str:
        """启动日志用的一行摘要。"""
        return f"资料 {len(self.docs())} 份 / {self.chunk_count()} 块，标准答案 {self.entry_count()} 条"

    # ---- 群消息（只留一天，见 group_msgs 建表那段）----

    def add_group_msg(
        self, *, group_id: int, user_id: int, nickname: str, role: str,
        message_id: int, reply_to: int, at_me: bool, body: str,
    ) -> None:
        with self._tx() as db:
            db.execute(
                "INSERT INTO group_msgs(group_id, user_id, nickname, role, message_id, reply_to, at_me, body, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (group_id, user_id, nickname, role, message_id, reply_to, int(at_me), body, _now()),
            )

    def group_msgs_between(self, start: str, end: str) -> list[sqlite3.Row]:
        """[start, end) 之间的群消息，按群、时间排好。时间是 `YYYY-MM-DD HH:MM:SS`。"""
        with self._tx() as db:
            return db.execute(
                "SELECT * FROM group_msgs WHERE created_at >= ? AND created_at < ? ORDER BY group_id, id",
                (start, end),
            ).fetchall()

    # ---- 管理员答过的（bot/kb/memory.py）----

    def add_memory(self, *, group_id: int, question: str, answer: str, staff_id: int, staff_name: str, vec: Sequence[float]) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO staff_memory(group_id, question, answer, staff_id, staff_name, vec, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (group_id, question, answer, staff_id, staff_name, pack(vec), _now(), _now()),
            )
            return int(cur.lastrowid or 0)

    def update_memory(self, mid: int, *, answer: str, staff_id: int, staff_name: str) -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE staff_memory SET answer=?, staff_id=?, staff_name=?, updated_at=? WHERE id=?",
                (answer, staff_id, staff_name, _now(), mid),
            )

    def memory_vecs(self, since: str = "") -> list[tuple[int, array.array]]:
        with self._tx() as db:
            rows = db.execute("SELECT id, vec FROM staff_memory WHERE updated_at >= ?", (since,)).fetchall()
            return [(r["id"], unpack(r["vec"])) for r in rows]

    def get_memory(self, mid: int) -> sqlite3.Row | None:
        with self._tx() as db:
            return db.execute("SELECT * FROM staff_memory WHERE id=?", (mid,)).fetchone()

    def memories(self, limit: int = 10) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute("SELECT * FROM staff_memory ORDER BY updated_at DESC, id DESC LIMIT ?", (limit,)).fetchall()

    def memory_count(self) -> int:
        with self._tx() as db:
            return int(db.execute("SELECT COUNT(*) c FROM staff_memory").fetchone()["c"])

    def use_memory(self, mid: int) -> None:
        with self._tx() as db:
            db.execute("UPDATE staff_memory SET used = used + 1 WHERE id=?", (mid,))

    def delete_memory(self, mid: int) -> bool:
        with self._tx() as db:
            return db.execute("DELETE FROM staff_memory WHERE id=?", (mid,)).rowcount > 0

    def staff_nicknames(self) -> set[str]:
        """最近群里出现过的自己人昵称（群消息只留一天）。拆转发的聊天记录时认客服用"""
        with self._tx() as db:
            rows = db.execute("SELECT DISTINCT nickname FROM group_msgs WHERE role=? AND nickname != ''", (ROLE_STAFF,)).fetchall()
            return {r["nickname"] for r in rows}

    def group_msgs_recent(self, group_id: int, since: str, limit: int = 60) -> list[sqlite3.Row]:
        """这个群 since 之后的群消息，**新的在前**。给「自己人转述的是谁的话」「客户刚发的截图」用"""
        with self._tx() as db:
            return db.execute(
                "SELECT * FROM group_msgs WHERE group_id=? AND created_at >= ? ORDER BY id DESC LIMIT ?",
                (group_id, since, limit),
            ).fetchall()

    def recent_answers(self, group_id: int, user_id: int, since: str, limit: int = 10) -> list[sqlite3.Row]:
        """这个群里这个人 since 之后收到过的回答，**新的在前**（2026-10-23）。

        给「最近对话」拼机器人自己前面回过什么用：客户说「还是不行」，得先看见
        上一条已经让他「换一个节点试试」了，才不会再原样发一遍。
        只要 answer / source / created_at 三列：这条消息是机器人说的、什么时候说的就够。
        """
        with self._tx() as db:
            return db.execute(
                "SELECT answer, source, created_at FROM qa_log"
                " WHERE group_id=? AND user_id=? AND created_at >= ?"
                " ORDER BY id DESC LIMIT ?",
                (group_id, user_id, since, limit),
            ).fetchall()

    def purge_group_msgs(self, before: str) -> int:
        """删掉 before 之前的群消息。返回删了几条。"""
        with self._tx() as db:
            return db.execute("DELETE FROM group_msgs WHERE created_at < ?", (before,)).rowcount

    # ---- 问答流水：复盘用的读写 ----

    def qa_rows_between(self, start: str, end: str) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute(
                "SELECT * FROM qa_log WHERE created_at >= ? AND created_at < ? ORDER BY id", (start, end)
            ).fetchall()

    def set_feedback(self, qa_id: int, said: str) -> None:
        with self._tx() as db:
            db.execute("UPDATE qa_log SET feedback=? WHERE id=?", (said, qa_id))

    def entry_feedback_rows(self, since: str) -> list[sqlite3.Row]:
        """时间窗口内、**命中过标准答案**的那些问答行里的客户反馈，只要 entry_id 和 feedback 两列。

        `review.render` 用它算「哪条标准答案在失效」。分类（好评/差评）不在这儿做：
        判法的定义只有 `review.feedback_kind` 一处，这里再写一遍 SQL 模式匹配，
        两边哪天改岔了没人发现。
        """
        with self._tx() as db:
            return db.execute(
                "SELECT entry_id, feedback FROM qa_log"
                " WHERE entry_id IS NOT NULL AND feedback <> '' AND created_at >= ?",
                (since,),
            ).fetchall()

    def set_audit(self, qa_id: int, verdict: str, note: str) -> None:
        with self._tx() as db:
            db.execute("UPDATE qa_log SET audit=?, audit_note=? WHERE id=?", (verdict, note, qa_id))

    def chunks_text(self, ids: Iterable[int]) -> list[tuple[str, str]]:
        """[(标题, 正文)]，按给的顺序。已经被重新导入冲掉的 id 跳过。"""
        got = self.chunks_by_ids(ids)
        return [(got[i][0], got[i][1]) for i in ids if i in got]

    # ---- 复盘草稿 ----

    def add_draft(
        self, *, kind: str, question: str, answer: str = "", aliases: str = "",
        entry_id: int | None = None, cluster_id: int | None = None, evidence: str = "", note: str = "",
        options: Sequence[dict] = (), merge_from: int | None = None,
        source_url: str = "", crawl_id: int | None = None,
    ) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO kb_drafts(kind, entry_id, cluster_id, question, aliases, answer, evidence, note,"
                " options, merge_from, source_url, crawl_id, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (kind, entry_id, cluster_id, question, aliases, answer, evidence, note,
                 json.dumps(list(options), ensure_ascii=False) if options else "", merge_from,
                 source_url, crawl_id, DR_PENDING, _now()),
            )
            return int(cur.lastrowid or 0)

    def pending_merge_for(self, a: int, b: int) -> bool:
        """这两条答案是不是已经有一条合并草稿在等 / 被拒过（拒过的不再提）"""
        with self._tx() as db:
            return db.execute(
                "SELECT 1 FROM kb_drafts WHERE kind=? AND state IN (?,?)"
                " AND ((entry_id=? AND merge_from=?) OR (entry_id=? AND merge_from=?))",
                (DR_MERGE, DR_PENDING, DR_REJECTED, a, b, b, a),
            ).fetchone() is not None

    def move_entry_refs(self, src: int, dst: int) -> None:
        """合并答案时，把挂在 src 上的问题类和附图挪到 dst"""
        with self._tx() as db:
            db.execute("UPDATE clusters SET entry_id=? WHERE entry_id=?", (dst, src))
            db.execute("UPDATE kb_images SET entry_id=? WHERE entry_id=?", (dst, src))

    def drafts(self, state: str = DR_PENDING, limit: int = 50) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute(
                "SELECT * FROM kb_drafts WHERE state=? ORDER BY id LIMIT ?", (state, limit)
            ).fetchall()

    def draft_count(self, state: str = DR_PENDING) -> int:
        with self._tx() as db:
            return int(db.execute("SELECT COUNT(*) c FROM kb_drafts WHERE state=?", (state,)).fetchone()["c"])

    def audit(self, action: str, entry_id: int | None, question: str, who: int = 0, name: str = "") -> None:
        """记一笔谁动了哪条标准答案。**出错不抛**：记不上不该挡住定答案本身"""
        try:
            with self._tx() as db:
                db.execute(
                    "INSERT INTO kb_audit(action, entry_id, question, who, name, created_at) VALUES (?,?,?,?,?,?)",
                    (action, entry_id, question[:120], who, name[:30], _now()),
                )
        except sqlite3.Error:
            log.warning("记标准答案改动失败", exc_info=True)

    def audits_between(self, start: str, end: str) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute(
                "SELECT * FROM kb_audit WHERE created_at >= ? AND created_at < ? ORDER BY id", (start, end)
            ).fetchall()

    @staticmethod
    def draft_options(row: sqlite3.Row) -> list[dict]:
        """草稿的几种说法。老草稿、读不出来的 → 只有 answer 那一种"""
        try:
            opts = json.loads(row["options"] or "[]")
        except (ValueError, TypeError, IndexError, KeyError):
            opts = []
        opts = [o for o in opts if isinstance(o, dict) and str(o.get("answer") or "").strip()]
        if not opts and row["answer"]:
            opts = [{"label": "", "answer": row["answer"]}]
        return opts

    def get_draft(self, draft_id: int) -> sqlite3.Row | None:
        with self._tx() as db:
            return db.execute("SELECT * FROM kb_drafts WHERE id=?", (draft_id,)).fetchone()

    def pending_draft_for_cluster(self, cluster_id: int) -> bool:
        """这一类是不是已经有一条草稿在等你了。有就别每晚再起一条一样的"""
        with self._tx() as db:
            return db.execute(
                "SELECT 1 FROM kb_drafts WHERE cluster_id=? AND state=?", (cluster_id, DR_PENDING)
            ).fetchone() is not None

    def rejected_for_cluster(self, cluster_id: int) -> bool:
        """这一类的草稿你拒过。拒过的不再起新草稿 —— 不然每晚都来烦你同一件事"""
        with self._tx() as db:
            return db.execute(
                "SELECT 1 FROM kb_drafts WHERE cluster_id=? AND state=?", (cluster_id, DR_REJECTED)
            ).fetchone() is not None

    def drafts_since(self, since: str, limit: int = 60) -> list[sqlite3.Row]:
        """since 之后起的草稿，不管审没审（管理员大白话「把那几条恢复」要找得到被删掉的）"""
        with self._tx() as db:
            return db.execute(
                "SELECT * FROM kb_drafts WHERE created_at >= ? ORDER BY id DESC LIMIT ?", (since, limit)
            ).fetchall()

    def reopen_draft(self, draft_id: int) -> bool:
        """被拒掉的草稿放回待审（管理员说要恢复）。已经采纳的不动"""
        with self._tx() as db:
            return db.execute(
                "UPDATE kb_drafts SET state=?, decided_by=NULL, decided_at=NULL WHERE id=? AND state=?",
                (DR_PENDING, draft_id, DR_REJECTED),
            ).rowcount > 0

    def decide_draft(self, draft_id: int, state: str, by: int) -> bool:
        """把一条待审草稿标成采纳 / 拒绝。**只动还在待审的**，同一条点两次第二次返回 False"""
        # 审完就把原话摘录清掉：群消息「只留一天」，摘录是为了让你审的时候看得见原话，
        # 审完它就没用了，留着等于把客户原话长期存下来
        with self._tx() as db:
            cur = db.execute(
                "UPDATE kb_drafts SET state=?, decided_by=?, decided_at=?, evidence='' WHERE id=? AND state=?",
                (state, by, _now(), draft_id, DR_PENDING),
            )
            return cur.rowcount > 0

    def set_draft_options(self, draft_id: int, options: Sequence[dict]) -> None:
        """给还在待审的草稿补几种说法（老草稿只有一种）。answer 列换成第一种"""
        opts = [o for o in options if str(o.get("answer") or "").strip()]
        if not opts:
            return
        with self._tx() as db:
            db.execute(
                "UPDATE kb_drafts SET options=?, answer=? WHERE id=? AND state=?",
                (json.dumps(opts, ensure_ascii=False), opts[0]["answer"], draft_id, DR_PENDING),
            )

    def update_draft_text(self, draft_id: int, *, question: str, answer: str, aliases: str) -> None:
        """审之前改草稿的字（6099 页面上改完再采纳）"""
        with self._tx() as db:
            db.execute(
                "UPDATE kb_drafts SET question=?, answer=?, aliases=? WHERE id=? AND state=?",
                (question, answer, aliases, draft_id, DR_PENDING),
            )

    # ---- 草稿带的图（爬常见问题时抓的截图）----

    def add_draft_image(self, draft_id: int, file: str, caption: str = "") -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO kb_draft_images(draft_id, file, caption, created_at) VALUES (?,?,?,?)",
                (draft_id, file, caption, _now()),
            )
            return int(cur.lastrowid or 0)

    def draft_images(self, draft_id: int) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute("SELECT * FROM kb_draft_images WHERE draft_id=? ORDER BY id", (draft_id,)).fetchall()

    def get_draft_image(self, image_id: int) -> sqlite3.Row | None:
        with self._tx() as db:
            return db.execute("SELECT * FROM kb_draft_images WHERE id=?", (image_id,)).fetchone()

    def drop_draft_images(self, draft_id: int, keep: Iterable[int] | None = None) -> list[str]:
        """删掉这条草稿的图（`keep` 里的留着），返回删掉的文件名让调用方删文件"""
        keep_ids = set(keep or ())
        with self._tx() as db:
            rows = db.execute("SELECT id, file FROM kb_draft_images WHERE draft_id=?", (draft_id,)).fetchall()
            gone = [r for r in rows if r["id"] not in keep_ids]
            db.executemany("DELETE FROM kb_draft_images WHERE id=?", [(r["id"],) for r in gone])
            return [r["file"] for r in gone]

    def move_draft_images(self, draft_id: int, entry_id: int, keep: Iterable[int] | None = None) -> int:
        """采纳：这条草稿的图挪成标准答案的附图（`keep` 给了就只挪这几张，别的删记录）。返回挪了几张。
        文件本来就在 data/kb_images/ 里，不用搬"""
        keep_ids = None if keep is None else set(keep)
        with self._tx() as db:
            rows = db.execute("SELECT id, file FROM kb_draft_images WHERE draft_id=? ORDER BY id", (draft_id,)).fetchall()
            moved = [r for r in rows if keep_ids is None or r["id"] in keep_ids]
            db.executemany(
                "INSERT INTO kb_images(entry_id, file, created_at) VALUES (?,?,?)",
                [(entry_id, r["file"], _now()) for r in moved],
            )
            db.execute("DELETE FROM kb_draft_images WHERE draft_id=?", (draft_id,))
            return len(moved)

    def draft_image_files(self) -> set[str]:
        with self._tx() as db:
            return {r["file"] for r in db.execute("SELECT file FROM kb_draft_images")}

    def draft_questions(self, state: str = DR_PENDING) -> list[str]:
        """还在待审的草稿问题（爬常见问题时去重用）"""
        with self._tx() as db:
            return [r["question"] for r in db.execute("SELECT question FROM kb_drafts WHERE state=?", (state,))]

    # ---- 爬常见问题的任务 ----

    def crawl_start(self, url: str, max_pages: int) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO crawl_jobs(url, state, max_pages, created_at) VALUES (?,?,?,?)",
                (url, "running", max_pages, _now()),
            )
            return int(cur.lastrowid or 0)

    def crawl_resume(self, job_id: int, max_pages: int) -> None:
        """把一个停了的任务重新标成在跑。**统计不清零**：页数、草稿数接着累，
        页面上看到的是这个任务从头到现在的总数"""
        with self._tx() as db:
            db.execute(
                "UPDATE crawl_jobs SET state='running', max_pages=?, error='', finished_at=NULL WHERE id=?",
                (max_pages, job_id),
            )

    def crawl_update(self, job_id: int, **fields: Any) -> None:
        allowed = {"state", "pages", "found", "drafts", "images", "replaced", "log", "error", "finished_at",
                   "seen", "queue"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return
        with self._tx() as db:
            db.execute(
                f"UPDATE crawl_jobs SET {', '.join(f'{k}=?' for k in cols)} WHERE id=?",
                (*cols.values(), job_id),
            )

    def crawl_get(self, job_id: int) -> sqlite3.Row | None:
        with self._tx() as db:
            return db.execute("SELECT * FROM crawl_jobs WHERE id=?", (job_id,)).fetchone()

    def crawl_jobs(self, limit: int = 20) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute("SELECT * FROM crawl_jobs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()

    def crawl_fail_running(self) -> int:
        """重启之前还在跑的，标成中断（进程没了，任务也没了）"""
        with self._tx() as db:
            return db.execute(
                "UPDATE crawl_jobs SET state='failed', error='机器人重启，爬到一半停了', finished_at=? WHERE state='running'",
                (_now(),),
            ).rowcount

    # ---- 复盘记录 ----

    def review_start(self, day: str) -> int:
        with self._tx() as db:
            cur = db.execute("INSERT INTO reviews(day, started_at) VALUES (?, ?)", (day, _now()))
            return int(cur.lastrowid or 0)

    def review_finish(self, review_id: int, *, ok: bool, llm_calls: int, tokens: int, summary: str, error: str = "") -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE reviews SET finished_at=?, ok=?, llm_calls=?, tokens=?, summary=?, error=? WHERE id=?",
                (_now(), int(ok), llm_calls, tokens, summary, error, review_id),
            )

    # ---- 自己人名单 ----

    def trusted_list(self) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute("SELECT user_id, note, created_at FROM trusted ORDER BY created_at").fetchall()

    def trusted_ids(self) -> frozenset[int]:
        with self._tx() as db:
            return frozenset(int(r["user_id"]) for r in db.execute("SELECT user_id FROM trusted"))

    def add_trusted(self, user_id: int, note: str) -> bool:
        """加一个，返回是不是新加的。已经在了就只改备注"""
        with self._tx() as db:
            existed = db.execute("SELECT 1 FROM trusted WHERE user_id=?", (user_id,)).fetchone() is not None
            db.execute(
                "INSERT INTO trusted(user_id, note, created_at) VALUES (?,?,?)"
                " ON CONFLICT(user_id) DO UPDATE SET note=excluded.note",
                (user_id, note, _now()),
            )
            return not existed

    def remove_trusted(self, user_id: int) -> bool:
        with self._tx() as db:
            return db.execute("DELETE FROM trusted WHERE user_id=?", (user_id,)).rowcount > 0

    # ---- 经验本 ----

    def lessons(self, state: str = "active", limit: int = 30) -> list[sqlite3.Row]:
        with self._tx() as db:
            return db.execute(
                "SELECT id, text, evidence, seen, state, first_at, last_at FROM lessons"
                " WHERE state=? ORDER BY seen DESC, last_at DESC LIMIT ?",
                (state, limit),
            ).fetchall()

    def lesson_vecs(self) -> list[tuple[int, str, array.array]]:
        """[(id, state, 向量)]。划掉的也要：同一件事划掉了就别再当新想法冒出来"""
        with self._tx() as db:
            return [(r["id"], r["state"], unpack(r["vec"])) for r in db.execute("SELECT id, state, vec FROM lessons")]

    def add_lesson(self, text: str, vec: Sequence[float], evidence: str) -> int:
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO lessons(text, vec, evidence, first_at, last_at) VALUES (?,?,?,?,?)",
                (text, pack(vec), evidence, _now(), _now()),
            )
            return int(cur.lastrowid or 0)

    def bump_lesson(self, lesson_id: int, evidence: str) -> None:
        """同一条规律又冒出来了。**同一天冒两次只算一次**（last_at 是今天就不加）"""
        with self._tx() as db:
            db.execute(
                "UPDATE lessons SET seen = seen + CASE WHEN substr(last_at,1,10)=? THEN 0 ELSE 1 END,"
                " last_at=?, evidence=? WHERE id=?",
                (today(), _now(), evidence, lesson_id),
            )

    def dismiss_lesson(self, lesson_id: int) -> bool:
        with self._tx() as db:
            return db.execute(
                "UPDATE lessons SET state='dismissed' WHERE id=? AND state='active'", (lesson_id,)
            ).rowcount > 0

    # ---- 考试用：拍一份快照 ----

    def snapshot(self, path: Path) -> None:
        """把整个库拷一份到 path。**用 SQLite 的 backup，不是复制文件**：机器人一直在写，
        直接 cp 可能拷到写了一半的页。考试要在副本上跑 —— 回答会建问题类、给答案 +1 命中，
        在正式库上考一次就是往日报里灌几十条假数据"""
        dst = sqlite3.connect(path)
        try:
            with self._lock:
                self._db.backup(dst)
        finally:
            dst.close()

    def latest_review(self) -> sqlite3.Row | None:
        """最近一次跑完的复盘（/复盘详情 看全文用）。没跑成的（summary 空）跳过"""
        with self._tx() as db:
            return db.execute("SELECT * FROM reviews WHERE summary != '' ORDER BY id DESC LIMIT 1").fetchone()

    def qa_entry_id(self, qa_id: int) -> int | None:
        """这条问答当时命中的标准答案编号；查资料答的 / 没有这条 → None"""
        with self._tx() as db:
            row = db.execute("SELECT entry_id FROM qa_log WHERE id=?", (qa_id,)).fetchone()
            return int(row["entry_id"]) if row and row["entry_id"] else None

    def last_review(self, day: str) -> sqlite3.Row | None:
        with self._tx() as db:
            return db.execute("SELECT * FROM reviews WHERE day=? ORDER BY id DESC LIMIT 1", (day,)).fetchone()
