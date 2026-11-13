"""群里的 AI 问答。@机器人 或者用 `/问 …` 开头提问。

**为什么要先被点名才答**：客服群里客户之间会互相聊，机器人逢消息必答
就是刷屏，而且它答错的概率会被放大到每一条消息上。被叫到才开口，
是让人先建立「它是个工具」的预期。

几道门，顺序不能换：

1. **群白名单**（`settings.group_enabled`）。这个号还在别的陌生群里，
   漏这道门就是跑去人家群里乱说话。
1.5. **喊人工不用 @ 我**（2026-09-24 加的）。真机上客户没 @ 喊了「转人工」，
   机器人一声不吭。这一条排在「叫没叫我」的判断里面，是**唯一**不用 @ 就触发
   的口——退款/价格/发票/问答/寒暄全都还要 @，别顺手推广，见 `on_group` 里的注释。
2. **碰了不聊的话题直接挡**（`bot/guard.py`：黄赌毒政），回一句话就完。
   排在退款前面 —— 退款是「转人工」，红线不转人工，把这种麻烦推给同事不叫处理。
3. **人工接管中只回「稍等」那句**（阶段 6，`bot/handoff.py`），不查资料、不调模型、
   不私聊。**只认「人工接管」，「等人工」期间照常往下走** —— 理由见那个文件开头。
4. **客户点名要人工就转人工**（`HUMAN_WORDS`）。**排在长度检查前面**：
   人越急写得越长，一条两百字的火气话里写着「转人工」，要是先撞上
   「问题有点长，挑最关键的一句问」，那就是在最不该讲道理的时候讲道理。
5. **提到退款直接转人工**，不查资料不调模型（规矩见下面 REFUND_WORDS）。
6. **沾价格转人工**（`PRICE_WORDS`），不让模型开口。问「倍率」例外，走问答（`RATE_WORD`，2026-09-28）。
   **命中标准答案的照着回**（2026-09-28，`from_entry`）：你亲笔写过的就是能说的，没命中才转人工。
   理由见下面那段注释——一句话：资料里没有金额，它答只能答出官腔。
7. **沾发票转人工**（`INVOICE_WORDS`，2026-09-23 加的），命中标准答案的照着回，同上。开票要落到抬头、
   税号、税点上，错一个字就要重开一张，这种事不该由模型开口。
8. **每人一个冷却**（`QA_COOLDOWN`）。一次问答要花钱，连点十下就是十次。

过了这几道门之后分两路走，**命中即停**（2026-09-23 管理员要的「两个回答方式」）：

- **寒暄** → 闲聊模式（`kb/smalltalk.py`），回一句人话，不查资料、不记待办
- **其余** → 问答模式：标准答案 → 查资料 → 答不上来就记下来等你定调

**闲聊只认白名单里的整条消息，不是答不上来时的兜底。** 把它当兜底的后果是：
客户问一件资料里没写的事，模型会用自己的常识编一个 —— 那跟硬编退款政策
是同一类事故，只是更隐蔽。挡住编造的那道闸是「答不上来 → 记待办」，
不能让闲聊把它绕开。

转人工的五个口（要人工、退款、价格、发票、答不上来）都会给这个客户开一条「等人工」会话，
私聊通知末尾带会话编号。
5 分钟没动静自动关（`bot/handoff.py` 的 IDLE_MINUTES），`/结束 编号` 随时能关。
下班时间（9:00-18:00 以外）转人工的几句话术后面补一句什么时候有人（`with_hours`）。
超管自己在群里开口也在这里接住（排在「叫没叫我」前面，他回客户不会 @我）。

**不做 DRY_RUN 分支**：2026-09-22 管理员定的，「我现在就在测试群，不需要开那个」。
安全网是群白名单（`ENABLED_GROUPS` 现在只有测试群），不是演练开关。
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from dataclasses import replace
from datetime import datetime, timedelta

from ..config import Settings
from ..crisis import CARE, HOTLINE
from ..crisis import hit as crisis_hit
from ..dispatcher import Dispatcher
from ..events import GroupMessage
from ..guard import DECLINE, topic
from ..handoff import (
    OFF_HOURS_TEXT,
    R_CRISIS,
    R_ERROR,
    R_HUMAN,
    R_INVOICE,
    R_MISS,
    R_PRICE,
    R_REFUND,
    Handoffs,
    off_hours,
    tag,
)
from ..kb import memory, notice, smalltalk
from ..kb.review import FB_BAD, FB_GOOD, feedback_kind
from ..kb.watch import _QUESTION, order_re  # 同一把尺：像不像问句、认不认得出订单号
from . import relay
from ..kb.answer import ERROR_TEXT, Answerer, Reply, ask_label, clean_for_chat
from ..kb.llm import LLM, LLMError, ModelMissing
from ..kb.store import (
    SRC_BLOCK,
    SRC_CHAT,
    SRC_ERROR,
    SRC_HOLDING,
    SRC_HUMAN,
    SRC_KB,
    SRC_MEMORY,
    SRC_MISS,
    SRC_NOTICE,
    SRC_RAG,
    ROLE_STAFF,
    KB_IMAGE_DIR,
    KBStore,
)
from ..onebot import ApiError, OneBotClient, at, image_b64, text
from ..onebot import reply as quote_seg

log = logging.getLogger(__name__)

# 提到退款就转人工，AI 不许碰。**只认这几个词，不做模糊匹配。**
# 光看一个「退」字的话，「退出登录」「退群」「退一步说」全都会被拦掉。
# 为什么必须硬拦：整份灵眸文档里「退款」出现 0 次（抓下来数过的），
# AI 无论如何都答不出，不拦就只剩硬编，而硬编退款政策是要赔钱的。
#
# 2026-09-24 补词：客户实际不说「我要申请退款」，说的是「这个能退吗」「充错了可以退不」。
# 补进来的是「能退」「可以退」，加上「钱退不出来」这一类抱怨。
#
# **原先想直接收裸的「退不」，实测不能收**：它会拦下「退不出去登录界面」，
# 正是本段开头点名不许误伤的「退出登录」那一家。所以「退不」只收带钱的搭配
# （退不了钱 / 钱退不 / 退不回 / 退不出来），靠「来」和「钱」跟「退不出去」「退不了群」分开。
# 「可以退不」这种问法由「可以退」兜住，不需要裸「退不」。
REFUND_WORDS = (
    "退款", "退钱", "申请退款", "要退", "能不能退",
    "能退", "可以退",
    "退不了钱", "钱退不", "退不回", "退不出来",
)

# 豁免词。照 HUMAN_EXEMPT / INVOICE_EXEMPT 的先例列外不列内，
# **但匹配方式跟那两处反着来：这里是把豁免词从句子里抠掉再匹配，不是见到就整句放行。**
# 退款是红线闸，标准是宁可误伤、不可漏。整句放行的话
# 「退出账号后还能退款吗」会因为含「退出」被整句放掉 —— 那是真退款问题漏掉了。
# 抠字只让「退出」这两个字不参与匹配，剩下的「…还能退款吗」照样拦住。
REFUND_EXEMPT = ("退出", "退群", "退一步")

# 定版话术，管理员批过的原文。**一个字都不要改成「可以退」那类承诺**——
# 这句话是客户拿去截图的凭据，承诺了就得兑现。
#
# 2026-10-11 大哥要求补上「退款邮箱」：客户问退款时机器人只说了转人工、没说官方怎么申请，
# 客户还得再问一轮。下面的邮箱/时限是照官方《退款说明》第六条抄的（原件存
# knowledge/refund.md，也进了资料库），只补官方事实、**没有加任何新的承诺**；
# 金额、能不能退这类判断仍然交给人工，一个字都别在这句里自己下结论。
REFUND_TEXT = (
    "收到，退款的事我帮你转给人工同事处理。\n"
    "方便的话把订单号发一下，客服核对起来快一些。\n"
    "\n"
    "也可以自己走官方流程：用注册邮箱发邮件到 support@mail.lmuai.ai，附上订单号，"
    "2 个工作日内会回复；审核通过后 1–5 天原路退回（到账时间以支付通道为准）。"
)

# 客户已经把订单号给出来时的那一版。**客服真机上骂过一次才拆出来的**：
# 2026-10-20 18:29 客户先贴了 `sub2_2026102035cKxDNJ`、再说「想退款」，
# 机器人照 `REFUND_TEXT` 回了一句「方便的话把订单号发一下」—— 他刚刚贴的就是订单号，
# 等于没听他说话。大哥的原话：「客户的意思是这个订单号，下次直接就让客户申请就好啦，
# 先问一下什么问题因为什么，让客户可以找一下小开心来解决。」
#
# 所以这一版只做三件事：认下订单号、**问是什么问题什么原因**、把「自己走申请」的路给出来
# （顺带给个人口：群里找小开心）。官方事实那两句跟 `REFUND_TEXT` 逐字相同 ——
# 换的只是「要不要再要一遍订单号」，**没有新增任何承诺**，能不能退仍然交给人工。
REFUND_TEXT_WITH_ORDER = (
    "收到，订单号我记下了。\n"
    "方便说一下是什么问题、什么原因吗？\n"
    "\n"
    "确认要退的话直接走申请就行：用注册邮箱发邮件到 support@mail.lmuai.ai，附上订单号，"
    "2 个工作日内会回复；审核通过后 1–5 天原路退回（到账时间以支付通道为准）。\n"
    "群里也可以直接找小开心，让他帮你处理。"
)

# 往回翻多久的群消息，看他是不是刚刚已经把订单号贴出来了。
# 15 分钟：够覆盖「贴号 → 客服问一句 → 他说想退款」这一来一回，又不至于翻出昨天的单子。
ORDER_LOOKBACK_MINUTES = 15

# 客户点名要人工就转人工。**跟退款分开一道闸**，理由跟 guard.py 当初单设一道
# 是同一个：「接不接」和「怎么说」是两件事，混进已有的闸就是把两个判断绑死。
#
# **也不能塞进 kb/smalltalk.py 的白名单。** 那张白名单是整条消息精确匹配、
# 不是子串，塞进去只盖得住光打「转人工」三个字的，盖不住「我要转人工」。
# 那个精确匹配的性质本身是对的，别为这件事去改它。
#
# 取词标准跟红线闸**反过来**：这里宁可漏，不可误伤。漏了客户再说一遍就是了；
# 误伤是把一个正经业务问题当成要人，客户白等一轮。
HUMAN_WORDS = ("人工", "真人客服", "转客服", "找客服", "要客服", "叫客服", "人来处理")
# 「人工」会撞上「人工智能」—— 客户问「你是人工智能吗」是寒暄，不是要人。
# 照 guard.py 的 _EXEMPT 先例：列外不列内，比在 HUMAN_WORDS 里堆长词稳
HUMAN_EXEMPT = ("人工智能", "人工降雨", "人工成本", "人工审核", "人工标注")

# 2026-09-23 管理员的原话是「好的，已经叫人了」
HUMAN_TEXT = "好的，已经叫人了，稍等一下。"

# 沾价格一律转人工，不让模型开口。
#
# **为什么是一刀切**：整份灵眸文档里计费的段落有几十处，**具体金额 0 处**
# （抓下来数过的，文档自己写着「价格以当前分组配置为准…不承诺固定价格」）。
# 模型报不出数字，但手里攥着「分组倍率」「上游账户倍率」「按 token 计费」
# 这一整套机制 —— 它答出来的只会是一段听着像政策的官腔。实测过一次：
# 「gpt-6怎么计费」资料分 0.650 越过了资料线，模型确实读了五段计费规则，
# 全靠 _from_docs 末尾那个 NO_ANSWER 出口才没开口。**那是模型的判断，不是一道闸。**
#
# 取词标准跟要人工闸**又反过来**：价格这道**宁可误伤，不可漏**。
# 但「怎么充值」是纯流程问题，不该被挡 —— 所以**不收「充值」**，
# 也不收裸的「多少」（会误挡「gpt最新模型ID多少」）。
# 抓返佣那条靠行业名词「返佣」，不靠「多少」。现有语料实测：该挡 3 条全中，误挡 0 条。
# **发票原先也在这条「不收」名单里，2026-09-23 之后不是了** —— 它单独一道闸，见下。
PRICE_WORDS = (
    "价格", "多少钱", "费用", "收费", "优惠", "折扣", "价钱", "报价",
    "贵", "便宜", "计费", "划算", "性价比", "涨价", "降价", "返佣",
)

# 「倍率」**不在 PRICE_WORDS 里**，单独判（2026-09-28 晚上改的）。管理员看着后台分组列表定的：
# 「只有公开和不停用的是按量付费的倍率可以告诉用户，不需要多说，只需要回答用户问的就好了」。
# 这些倍率每天从模型广场抓进 knowledge/group-rates.md（scripts/fetch_rates.py），专属、停用的分组不在里面。
# 问倍率走问答；**只豁免「计费」**——客户说「按量计费的倍率」是在指分组类型，不是问价。
# 同一句里还带「多少钱」「贵」「优惠」这些，照旧转人工
RATE_WORD = "倍率"
RATE_OK = ("计费",)

# 「套餐」**不在 PRICE_WORDS 里**，单独判（2026-09-28 下午改的）。
# 上午管理员定了「套餐也按价格处理」，当天 15:21 就误伤：「claude pro的订阅套餐 支持1m的上下文吗？
# 怎么开启啊」是用法问题，回了一句「价格这块我说不准」。所以「套餐」只在**问买哪个、有哪些**
# 的时候才转人工；问套餐**能不能 / 怎么用**的（支持、开启、配置、切换、用不了…）照常走问答。
# 走问答也不怕报错价：套餐价格照购买页每天抓进了资料，还有程序外的硬事实闸兜着
# 2026-10-19 又误伤一次：新人问「CCPro入门版套餐里显示的 非官方逆向池 是什么意思」——
# 名词解释题，标准答案 #103 里就有「非官方逆向池」的原文，却被套餐闸拦去转人工。
# 所以再收一组**概念词**：问「是什么意思 / 有什么区别 / 是什么」照常走问答。
# 真问价不受影响：那句里要是带着「价格」「多少钱」，PRICE_WORDS 在前面已经拦了
PLAN_WORD = "套餐"
PLAN_USAGE = (
    "支持", "开启", "开通", "打开", "怎么用", "如何用", "使用", "配置", "设置", "切换", "上下文",
    "用不了", "不能用", "报错", "连不上", "模型", "额度", "到期", "续", "绑定", "分组", "key", "Key", "KEY",
    "能用", "可以用",
    # 概念词（2026-10-19）：名词解释不是问价
    "是什么意思", "什么意思", "啥意思", "是什么", "区别",
)

# 2026-09-23 管理员本人从三个候选里选定的（另两个：一个照 REFUND_TEXT 的结构、
# 附带问一句「哪个模型或套餐」，一个更短）。**照 REFUND_TEXT 的规矩办：一个字都别改**，
# 尤其别加「具体价格请咨询客服」之类的官腔。
PRICE_TEXT = "价格这块我说不准，让同事来跟你讲，已经叫人了。"

# 沾发票一律转人工。**2026-09-23 管理员在「部分放行」和「全量」之间选的全量**，
# 原话是只要提发票就叫人。
#
# **为什么值得单设一道闸**：开票要落到抬头、税号、税点、什么时候寄这些具体事上，
# 每一项都是错一个字就要重开的凭证，而文档里只有「支持开具增值税发票」这一句。
# 之前它是走问答的，实测「我在你们这充了一万，能开发票抬头写别的公司吗」
# 模型顺着合规那页答了「可以的…」—— 这种话不该由机器人说。
#
# 2026-09-23 的代价是标准答案 #3「开票能开专票吗」永远触发不了（闸排在问答前面）。
# **2026-09-28 起不是了**：闸里先查标准答案，命中照原文回（`from_entry`），没命中才转人工。
INVOICE_WORDS = ("发票", "开票", "专票", "普票", "抬头", "税点", "税率", "税号", "报销", "财务")
# 「报销」「财务」2026-09-29 加的：12:49 真客户「同事没回我 麻烦能请财务加个急吗？再晚就报销不了了」
# 一个「发票」都没提，漏过了发票闸，模型查资料报了商务的邮箱电话。管理员选的 1B：
# 词表加这两个，**再加一条「催进度」**：同一个客户 INVOICE_FOLLOW 秒内问过发票，
# 这次又带着「急 / 催 / 多久 / 什么时候 / 进度」这类词，也按发票处理（`invoice_follow_up`）
INVOICE_FOLLOW = 30 * 60
INVOICE_CHASE = ("急", "催", "多久", "什么时候", "啥时候", "几点", "进度", "还没", "没回", "怎么样了", "好了没", "今天能")
# 「抬头」是这组里唯一一个日常也用的词（「抬头看一眼」）。照 HUMAN_EXEMPT 的
# 先例列外不列内 —— 在 INVOICE_WORDS 里把它拆成「发票抬头」「抬头写」这种长词，
# 反而会漏掉「抬头能改吗」这种真问发票的
INVOICE_EXEMPT = ("抬头看", "抬头望", "抬头见", "一抬头", "抬起头")

# 照 PRICE_TEXT 的结构写的：一句话、说明去叫人、**不承诺能不能开**。
# 「可以开的，稍等」这种话一句都不能有 —— 能不能开、开什么抬头是他说了算
INVOICE_TEXT = "开票的事我让同事来跟你说，已经叫人了。"

# 调模型出错时私聊超管的最小间隔（秒）。中转站挂的那几分钟里每个问题都出错，
# 一条一条私聊会把手机刷爆；压成一条，其余的在 /会话 里都看得到
ERROR_NOTIFY_EVERY = 10 * 60
# 看图模型（含备用）都「不存在」时私聊超管的最小间隔（秒）。这是配置问题不是抖动，
# 改好 .env 重启之前每张图都会再撞一次，提醒一次就够
VISION_ALERT_EVERY = 6 * 3600
# 太短的多半接着上文说的（「什么意思」「能用吗」），没上下文对标准答案会对歪
UNASKED_MIN_CHARS = 6
# **不用 @ 我也答**（2026-10-15 管理员：「现在不需要@机器人了让机器人所有都回答但是前提得命中」）：
# 群里客户说的每一句，**像问句**（`watch._QUESTION` 那把尺）就往下判：
# 命中标准答案（`KB_HIT_SCORE`，跟 @ 我同一个数）或管理员答过的（`memory.MEMORY_SCORE`）→ 当场回；
# 只是沾边（`KB_NEAR_SCORE`）→ 交给正式答题路去查资料。都不够就不出声，
# 十分钟没人回的那道（answer_unasked + 盯群私聊超管）照旧兜着。
#
# **2026-10-16 砍过一轮**（管理员：「判断条件太多了…判断有误，把误伤的都删除掉」）：
# - 删掉「快模型看上下文判是不是在问客服」那道：它把答得了的 #11 判掉了（只看第一名），
#   而且每条没 @ 我的消息都要多花一次模型调用。改成**正则判像不像问句**，不要模型
# - 删掉没 @ 我另要 0.85 那道（UNASKED_SCORE）：命中线就一个数
# - 删掉「同一个人 60 秒内只答一次」那道（AUTO_COOLDOWN）：改成跟 @ 我一样的冷却（3 秒）
# - 删掉「同事 300 秒内指过这个客户就不插嘴」（STAFF_BUSY）：客户的问题不等
# 2026-10-19 又加回来一个更宽的（STAFF_PRESENT_MINUTES）：**没 @ 我**的自动插话前，
# 看最近这段时间群里有没有自己人说过话 —— 有就说明管理员在群里接着，机器人让位。
# 跟 10-16 砍掉的那版不一样：那版拦的是客户问的问题（管理员当时说客户的问题不等），
# 这版只拦没 @ 我的插话，客户 @ 我照答。真机：12:03 管理员回客户「下次早点申请」，
# 12:05 客户再追问，机器人还插「已叫人了」—— 管理员都接手了，别混
STAFF_PRESENT_MINUTES = 10
AUTO_MIN_CHARS = 4
# 「不像问句、但明显是出了事」的话也要接（2026-11-09 管理员：「充了之后发现没有 claude」为什么没回复）。
# 客户常常不写成疑问句，直接一句抱怨。只认故障/缺失类，不认闲聊
_TROUBLE = re.compile(
    r"没有.{0,8}(claude|gpt|opus|gemini|模型|分组)|看不到|用不了|不能用|打不开|连不上|报错|失败|"
    r"扣费|扣了钱|没反应|不给用|充了(?:之后|以后|后)|退不了"
)
_AT_TEXT = re.compile(r"@\S+")

# 「一个一个来」那句（2026-10-16 管理员：「客户都是群里的…回复不过来需要先和客户说一下一个一个来」）。
# 同一个群同时只答一条：他在等的时候先说一声，别让他以为没人理（2026-09-24 那次的教训：
# 不吭声比答错更伤）。**短**，而且每次换一句，不然同一句「稍等」连发三条比不说话还烦
ONCE_AT_A_TIME = (
    "我一个个来哈，先把手头这条看完就回你",
    "稍等哈，我一条一条看，你的问题记着呢",
    "先答完这条就看你这个",
)
# 同一个人的「稍等」多久之内只说一次（秒）
ONCE_EVERY = 60.0
# 机器人答完之后，客户多久之内**不 @ 我**回的话还算在回这次回答（秒，2026-10-16）。
# 真机那条：答完 1 分 40 秒客户回「好了 真的是网络问题 感谢」，没 @ 我，机器人一声没吭
AFTER_ANSWER = 600.0
# 客户说「好了 / 感谢」时收个尾。**短**，每次换一句；同一次回答只收一次尾
CLOSE_LINES = (
    "好嘞，解决了就好，后面有问题直接说",
    "不客气～有别的再叫我",
    "好的，能用了就行，有事随时问",
)
# 身份类：同一个人在同一个群，这么久之内**第二次**问「你是不是机器人」，就照实说（2026-10-16）。
# 第一次只报名、把话头带回正事；他再问一遍就是真想知道，绕下去就是骗人
IDENTITY_AGAIN = 300.0
# 没 @ 我的问题「沾边就问模型一句」时，最多拿前几条标准答案去问（2026-10-16）。
# 只问第一名会被关键词加分坑掉：真机那次第一名答不了、第二名才答得了
MERGE_JUDGE_TOP = 3
# 排队等上一条答完，最多等多久（秒）。等到了照常答；**等过头就并着答** ——
# 宁可偶尔交叉，也不能让谁的问题永远排不上（上一条的硬上限 120 秒，正常排不到这里）
QUEUE_MAX = 90.0

# 客户连着发几条算**一个问题**（2026-10-16 管理员：「客户发好几条判断是否是一个问题就可以了」）。
# 做法是等一小会儿：第一条先记下、睡 MERGE_WINDOW 秒，这期间同一个人再发就往这堆里加，
# 醒来把这几条并成一句交给答题路 —— 分开答就是答三次、每次都不全。
# **只在真要去答题之前等**：寒暄、转人工、退款、价格、发票、红线、想不开、收尾都当场回，不受影响
MERGE_WINDOW = 2.5
MERGE_MAX = 4  # 最多并几条，免得把一整段闲聊粘成一条问题
# 并出来的问题最长多少字：**跟单条消息的上限一样**（MAX_QUESTION），
# 别并出一条本来会被长度闸挡下的超长问题
MERGE_MAX_CHARS = 200

# 提问长度上限。太长的多半是粘贴了一大段日志，既烧 token 又检索不准
MAX_QUESTION = 200
# 太短的问不出东西（「?」「在吗」），直接引导一句，不花钱
MIN_QUESTION = 2
# 只 @ 我、一个字没打：往前翻他自己的话当成同一个问题，翻多久（分钟）。2026-10-16 加的
ASK_BACK_MINUTES = 10
# 发之前回头看一眼：「这条之后别的客户接过话没有」往前看多久（分钟）
CUT_IN_WINDOW = 5
# 客户之间正在聊的判据：相邻两条发言人换了几次。**2 次**才叫「你来我往」——
# 他 → 别的客户 → 他（或者别的客户 → 他 → 别的客户），说明两边都接了一轮以上。
# 只换 1 次可能只是别人插一句话，还看不出是在对话；换 2 次已经能确认话头在两个人之间来回。
# 真机 2026-10-26 12:05，群 2000000003：岳和 Rei1 聊短视频聊了十分钟，一来一回，
# 岳问「我怎么安装react+remotion」、Rei1 接「为什么不问问神奇的魔法海螺呢（」，
# 机器人把这两句都当成问自己的，插了话还开了等人工会话。
CHAT_SWITCHES = 2


def looks_like_refund(question: str) -> bool:
    """提到退款算不算。先把豁免词抠掉，剩下的部分再找退款词。"""
    rest = question
    for w in REFUND_EXEMPT:
        rest = rest.replace(w, "")
    return any(w in rest for w in REFUND_WORDS)


def wants_human(question: str) -> bool:
    """客户是不是在点名要人。豁免词优先，「人工智能」不算要人。"""
    if any(w in question for w in HUMAN_EXEMPT):
        return False
    return any(w in question for w in HUMAN_WORDS)


def has_order_no(text: str, prefix: str) -> bool:
    """这句话里有没有订单号。认法跟盯群那边完全一致（`watch.order_re` + 同一个前缀），
    不另造一把尺 —— 两处判断不一样，就会出现「盯群认得出、话术认不出」的错位。
    前缀由调用方传（`settings.approval_answer_prefix`），模块级拿不到 settings。"""
    pat = order_re(prefix)
    return bool(pat and pat.search(text or ""))


def looks_like_price(question: str) -> bool:
    # 倍率：问倍率本身走问答，「按量计费」里那个「计费」不算问价（见 RATE_WORD 上面那段）
    words = [w for w in PRICE_WORDS if w not in RATE_OK] if RATE_WORD in question else PRICE_WORDS
    if any(w in question for w in words):
        return True
    # 套餐：问有哪些 / 买哪个才算价格问题，问能不能用、怎么用的不算（见 PLAN_USAGE 上面那段）
    return PLAN_WORD in question and not any(w in question for w in PLAN_USAGE)


def with_hours(body: str) -> str:
    """转人工的几句话术：下班时间（handoff.WORK_FROM ~ WORK_TO 以外）后面补一句什么时候有人。
    **原话术一个字不动**，只在后面接一行 —— 那几句是管理员逐字定的"""
    return f"{body}\n{OFF_HOURS_TEXT}" if off_hours() else body


def invoice_follow_up(question: str) -> bool:
    """问过发票之后这句是不是在催（只看词，时间窗在 on_group 里判）"""
    return any(w in question for w in INVOICE_CHASE)


def looks_like_invoice(question: str) -> bool:
    """客户是不是在问发票。豁免词优先，「抬头看看」这种不算。"""
    if any(w in question for w in INVOICE_EXEMPT):
        return False
    return any(w in question for w in INVOICE_WORDS)


# 句末标点。半角 !? 也收：客户和模型都可能打英文标点
_SENT_END = re.compile(r".*?[~。！？…!?]+", re.S)
# 空行 = 段落分界
_PARA_GAP = re.compile(r"\n\s*\n+")
# 「行首是 1. 2. 3.」这种编号列表。**有它就不按标点切**，见 split_reply
_NUMBERED = re.compile(r"^\s*\d+[.、)]\s", re.M)


def typing_delay(piece: str, lo: float, hi: float) -> float:
    """发下一段之前停多久：按这一段的字数算「打字时间」，每字 TYPING_PER_CHAR 秒加一点抖动。

    **下限还是 REPLY_GAP_MIN~MAX 那个随机数**（风控给的，见 say）：短的一段不会因为字少就连发。
    上限 TYPING_MAX，长段也不让客户干等。
    """
    # min/max 兜一下：要是 .env 里把 MIN 填得比 MAX 大，random.uniform 不报错，会静默返回怪值
    floor = random.uniform(min(lo, hi), max(lo, hi))
    typing = len(piece) * TYPING_PER_CHAR + random.uniform(0.3, 0.8)
    return min(max(floor, typing), max(TYPING_MAX, floor))


# 打字速度。0.04 秒一个字，100 字的一段停 4 秒多
TYPING_PER_CHAR = 0.04
TYPING_MAX = 5.0
_LINK = re.compile(r"https?://\S+")


# 单段硬上限：**按字节算**（一个汉字 3 字节），默认 90 个汉字 = 270 字节。
#
# 为什么按字节不按字数（2026-10-16，管理员用 OneBot WS 在报告群做的对照实验）：
#   纯文字短消息 / 短句带链接 / 短句三行              → 都 OK
#   176 个汉字的整条标准答案（#2「地区不可用」）      → FAIL retcode=1200 Timeout: sendMsg
#   同一内容拆成 89 / 51 / 34 三段                    → 3/3 全 OK
# 176 个汉字 = 528 字节发不出去；89 个汉字 = 267 字节发得出去；
# 而「正文 55 字 + 一条 56 字的链接」只有 222 字节，实测也是 OK 的。
# 所以卡的是**字节**不是字数 —— 按字数算会把「短正文+出处链接」白白拆成两条。
SEND_SEG_BYTES = 270
# 一条回复最多发几个气泡（硬上限）。段数 REPLY_SEGMENTS 是软的，单段字节是硬的，两个一起会切出很多条
SEND_MAX_PIECES = 4

# 客户请求的是 api.lmuai.ai 这个地址（截图 / 原话里看得到）→ 回复末尾补一句建议填 .com（2026-10-27 管理员：
# 「我看到你上面请求的是 ai，推荐使用 com」）。.ai 是国际站，开梯子登录、选分组用的；工具里接口地址填 .com 国内直连
_AI_ENDPOINT = re.compile(
    r"api\.lmuai\.ai\s*/\s*(v1|chat|messages|responses|models|api)\b"
    r"|(base[_ ]?url|接口地址|endpoint|gateway|请求地址)[^\n]{0,40}api\.lmuai\.ai"
    r"|api\.lmuai\.ai[^\n]{0,40}(base[_ ]?url|returned http|接口地址)",
    re.I,
)
ENDPOINT_HINT = "另外看你请求的是 api.lmuai.ai，工具里的接口地址建议改成 https://api.lmuai.com，国内直连；.ai 是开梯子登录、选分组用的"


def endpoint_hint(texts: list[str], body: str) -> str:
    """客户用 .ai 当接口地址、回复里又没提 .com → 返回要补的那句，否则空串"""
    if "lmuai.com" in body:
        return ""
    return ENDPOINT_HINT if any(_AI_ENDPOINT.search(t or "") for t in texts) else ""
# 下刀顺序：换行 → 句末标点 → 逗号顿号 → 冒号空格 → 实在没有就硬切
_WRAP_ORDER = ("\n", "。", "！", "？", "；", "，", "、", "：", " ")
# 一条消息发几次（含第一次）。发送失败（retcode / 超时 / 连接断）就退避重试：
# 2026-10-16 真机那次是 sendMsg 超时（retcode=1200），退避一下常有救
SEND_TRIES = 3
SEND_BACKOFF = (1.5, 4.0)  # 第 2、3 次之前各等多久（秒）
# 带 http(s) 链接的回复，QQ 那边常常卡住不发（NapCat 报 sendMsg Timeout）。10-16~10-22 统计：
# 带链接的 67 条里 16 条超时，不带链接的 348 条里 2 条；欢迎语写的是不带 https:// 的「api.lmuai.com」，
# 一次都没失败过。所以第一次失败后，后面几次改发去掉 https:// 的那一版（10-21/22 售前4 两位客户没收到回复就是这个）
_SCHEME = re.compile(r"https?://", re.I)


def unlinked(segs: list[dict]) -> list[dict]:
    """消息段里文字的 http(s):// 去掉。没有链接就原样返回同一个列表（调用方据此判断要不要换）"""
    if not any(s.get("type") == "text" and _SCHEME.search(str((s.get("data") or {}).get("text", ""))) for s in segs):
        return segs
    return [
        {**s, "data": {**s["data"], "text": _SCHEME.sub("", s["data"]["text"])}} if s.get("type") == "text" else s
        for s in segs
    ]


def _size(s: str) -> int:
    """一段话的「重量」：UTF-8 字节数。发不出去是按字节算的（见 SEND_SEG_BYTES）"""
    return len(s.encode("utf-8"))


def _cap_pieces(text: str, cap: int) -> list[str]:
    """把一段压到 cap **字节**以内再返回。**链接整条不拆**（拆了的链接点不开）。

    真机那条为什么需要它：176 个汉字（528 字节）的 #2 标准答案是三行、**行间没有空行**，
    标准答案只按空行切 → 切出来还是 1 段 176 字 → 整条发出去 → sendMsg 超时 → 答案丢了。
    """
    text = text.strip()
    if not text or _size(text) <= cap:
        return [text] if text else []
    spans = [(m.start(), m.end()) for m in _LINK.finditer(text)]

    def in_link(i: int) -> bool:
        return any(a < i < b for a, b in spans)

    for sep in _WRAP_ORDER:
        # 从后往前找第一个「断在这里还不超重」的位置（尽量切在标点上，不硬切）
        for m in reversed(list(re.finditer(re.escape(sep), text))):
            i = m.end()
            if i >= len(text) or _size(text[:i]) > cap or in_link(i):
                continue
            return _cap_pieces(text[:i], cap) + _cap_pieces(text[i:], cap)
    # 一个标点都没有：硬切（按字节数着切）
    cut, acc = 0, 0
    for ch in text:
        acc += len(ch.encode("utf-8"))
        if acc > cap:
            break
        cut += 1
    if cut <= 0:
        cut = 1
    if in_link(cut):
        # 切在链接里了：整条链接留给下一段；整段就是一条长链（链接里没空格）时只能整条发
        start = next(a for a, b in spans if a < cut < b)
        if start <= 0:
            return [text]
        cut = start
    return _cap_pieces(text[:cut], cap) + _cap_pieces(text[cut:], cap)


def split_reply(body: str, *, limit: int, by_para: bool, single_max: int = 0) -> list[str]:
    """把一条长回复切成几段，**逐字不改，只改断行**。

    2026-09-24 加的，管理员要的「一段一段发」。真人客服不会把五步操作
    糊成一坨甩出来，是打一句发一句。

    **短的不切**（2026-10-09 他看真机截图说的「不需要分开发好几条，就是看字的长度」）：
    整条不超过 `single_max` 个字就一条发完。那张截图是三句话、一共不到一百字，被切成了三个气泡。
    `single_max=0` 不设门槛（老行为）。

    两种文本两种切法，不能混：

    - `by_para=True`（标准答案）：按**空行**切。他第 9 号答案是「1.~5. 五步 +
      空行 + 其他工具的接入方式也是一样的」——按空行切正好两段；按每个换行切
      会变成五条消息刷屏；按句末标点切**一段都切不出来**，那五行里一个句号都没有。
    - `by_para=False`（模型写的散文）：按句末标点切。查资料那路 `reply.text`
      末尾附的链接没有标点，会自然落进最后一段，跟真人甩个链接的样子一致。

    超出 `limit` 的尾巴**合并进最后一段**，不是丢掉 —— 宁可最后一段长一点，
    也不能把客户要的内容吞掉。`limit <= 1` 等于关掉分段，退回整条一次发。

    **一个字都不许改写**：标准答案是管理员自己写的字，分段只准改断行。

    **单段硬闸**（2026-10-16，见 `SEND_SEG_MAX`）：切完之后每段还要过 `_cap_pieces`，
    超过 `single_max` 继续往下切（换行 → 句末标点 → 逗号 → 硬切，链接整条不拆）。
    `limit`（段数）是**软**的：能并就并，并不到也不硬并 —— 宁可多发一两条，
    也不能把超长的段发出去（那条路是 sendMsg 超时、消息直接丢，客户什么都收不到）。
    """
    body = body.strip()
    # **按原始字数判**（2026-10-16 改的）。原来这里把链接排除在外（`_LINK.sub`），
    # 理由是「查资料那路末尾附的出处链接五六十个字，算进去截图那种短回答也会被切」。
    # 但发不出去这条限制是**按整条消息的字节数**来的，不看链接不链接：
    # 「3 条长链接 + 21 个字」被这条判成短消息 → 整条 258 字发出去 → 照样 sendMsg 超时。
    # 现在链接照样算长度，只是在切的时候**整条链接不拆**（`_cap_pieces`）
    if not body or limit <= 1 or (single_max and _size(body) <= single_max * 3):
        return [body] if body else []

    # **回复里有编号列表就一律按空行切**，哪怕调用方要的是按标点切。
    # 真机上出过（2026-09-24 21:29，售前群）：模型答桌面版怎么配，四步里
    # 第 2 步是菜单名「Configure Third-Party Inference…」，末尾那个 … 被当成
    # 句末标点，于是「1. 2.」先到、隔两秒才来「3. 4.」——编号列表被劈成两半，
    # 比一次发完更难跟。列表本来就是一个整体，不该按句子拆。
    if by_para or _NUMBERED.search(body):
        parts = [p.strip() for p in _PARA_GAP.split(body) if p.strip()]
    else:
        # **句末标点切分要跳过链接内部**（2026-10-16 实测）：URL 里的 `?`、`&` 会被
        # `_SENT_END` 当成句子边界，「https://…/path?a=1&b=2」被劈成两半，两半都点不开
        spans = [(m.start(), m.end()) for m in _LINK.finditer(body)]

        def in_link(i: int) -> bool:
            return any(a < i < b for a, b in spans)

        # **切点本身**（那个标点）落在链接里就不切 —— `_SENT_END` 是非贪婪「到下一个标点」，
        # URL 里的 `?` 正好让它把「https://…/path?」当成一句，切出来的两半都点不开
        cuts = [m.end() for m in _SENT_END.finditer(body) if not in_link(m.end() - 1)]
        parts, prev = [], 0
        for c in cuts:
            if c > prev:
                parts.append(body[prev:c].strip())
                prev = c
        tail = body[prev:].strip()
        if tail:
            parts.append(tail)
        parts = [p for p in parts if p]

    if not parts:
        return [body]
    if len(parts) <= limit and (not single_max or _size(body) <= single_max * 3):
        return parts
    if not single_max:
        # 老行为（没配单段上限）：尾巴并进最后一段，不是丢掉
        return parts[: limit - 1] + ["\n".join(parts[limit - 1 :])] if len(parts) > limit else parts
    cap = single_max * 3  # 字节：90 个汉字
    # **每段先过长度硬闸**（超重的那条路会 sendMsg 超时、消息直接丢）
    capped: list[str] = []
    for p in parts:
        capped.extend(_cap_pieces(p, cap))
    parts = [p for p in capped if p]
    if len(parts) <= limit:
        return parts
    # 段数超了就**尽量**并（并起来还不超单段上限才并）。
    # 实在并不进 limit 以内就多发几条：段数是软限制，长度（字节）是硬限制。
    # 用换行接而不是空格：并的本来就是不同句群/段落
    while len(parts) > limit:
        best: tuple[int, int] | None = None
        for i in range(len(parts) - 1):
            # +1 是拼起来时中间那个换行
            n = _size(parts[i]) + _size(parts[i + 1]) + 1
            if n <= cap and (best is None or n > best[0]):
                best = (n, i)
        if best is None:
            break
        i = best[1]
        parts[i : i + 2] = [parts[i] + "\n" + parts[i + 1]]
    return parts


def register(
    dispatcher: Dispatcher,
    client: OneBotClient,
    settings: Settings,
    store: KBStore,
    answerer: Answerer,
    llm: LLM,
    handoffs: Handoffs,
) -> Callable[[Mapping[str, Any]], Awaitable[bool]]:
    """注册群消息处理器。返回 `answer_unasked`，给盯群（kb/watch.py）答没 @ 我的问题用"""
    # {user_id: 上次提问的时间}。只在内存里，重启就清——冷却是防连点的,
    # 不是配额，重启后从头算没有任何坏处
    last: dict[int, float] = {}
    # 已经私聊报过的问题类。同一类问题连着三个人问，私聊只响一次;
    # 完整清单在每晚复盘（/复盘详情）里，不靠私聊刷屏
    notified: set[int] = set()
    # 上次因为「调模型出错」私聊超管的时间。中转站一挂，每个客户的每个问题都会出错，
    # 按问题类去重没用（出错时多半连向量都没算出来，没有问题类），所以按时间窗压
    error_notified_at = -ERROR_NOTIFY_EVERY - 1.0
    # 上次因为「看图模型都不存在」私聊超管的时间。见 read_screen
    vision_alerted = -VISION_ALERT_EVERY - 1.0
    # {(group_id, user_id): 上次群里回了「要人工」话术的时间}。**只压这一道闸的
    # 群内话术**，理由和用法见 handle_human。跟上面 `last` 一样只在内存里，
    # 重启就清——多回一句好过漏回一句。键必须带 group_id：会话是按群分的
    # （`uq_handoffs_open` 就是 (group_id, user_id)），A 群喊过不该压住 B 群
    human_replied: dict[tuple[int, int], float] = {}
    # {(group_id, user_id): (上次问题, 时间, 答中的标准答案编号)}。追问带上一句用（relay.py 第 3 条）。
    # 只在内存里：重启丢了就是少一次上下文，不影响答题
    asked: dict[tuple[int, int], tuple[str, float, int | None]] = {}
    # {(group_id, user_id): 机器人上一条反问的时间}（relay.py 第 4 条，2026-10-16）。
    # 有这条 = 机器人刚问了他一句、正等他答，**他那句不用 @ 我也接**。
    # 只在内存里：重启丢了就是少接一次话，不影响答题
    asked_back: dict[tuple[int, int], float] = {}
    # {(group_id, user_id): 上次问发票的时间}。催进度按发票处理用（INVOICE_FOLLOW），只在内存里
    invoice_asked: dict[tuple[int, int], float] = {}
    # 自己人名单（超管 + TRUSTED + 6099「自己人」页），跟转人工会话共用一份（handoff.Handoffs.staff）
    staff = handoffs.staff
    # 自动回复（不用 @ 我那条路）：{(群, 人): 上次回的时间}；{(群, 人): 上次回的是哪条}，同一条不回两遍
    auto_last: dict[tuple[int, int], float] = {}
    auto_what: dict[tuple[int, int], str] = {}
    # 一个一个来（2026-10-16）：{群号: 应答锁}，同一个群里同时只答一条；
    # {(群, 人): 上次跟他说「稍等」的时间}。都在内存里，重启就清
    group_locks: dict[int, asyncio.Lock] = {}
    once_said: dict[tuple[int, int], float] = {}
    # {(群, 人): 上次问「你是谁 / 是不是机器人」的时间}。五分钟内再问一次就照实说（IDENTITY_AGAIN）
    id_asked: dict[tuple[int, int], float] = {}
    # 正在收着的「客户连着发的几条」：{(群, 人): [原话, ...]}，见 collect_run（MERGE_WINDOW）
    merging: dict[tuple[int, int], list[str]] = {}
    # {(群, 人): 最近**没 @ 我就答出去的那句问题**（正在答的也算）}。
    # 没 @ 我那条路在调模型之前先登记，客户随后单独 @ 我时，主路一看就知道这句已经在答/刚答过，
    # 不会再回一条（2026-10-16 真机：先发问题再单独 @ 我，回了「格式提示 + 答案」两条）
    auto_asked: dict[tuple[int, int], str] = {}
    # {(群, 人): 机器人上次答他的时间}（2026-10-16）。他之后不 @ 我说「好了」「还是不行」也接，
    # 见 on_group 没 @ 我那段第三条。接过一次就清，不会每句话都接
    answered_at: dict[tuple[int, int], float] = {}
    judge_llm = llm  # 复核只剩一级之后，这儿就是同一个模型（给「学同事答法」那道判断题用）
    # 记管理员答法的后台任务。留着引用，免得被回收
    learn_tasks: set[asyncio.Task[None]] = set()

    def learn_staff_reply(ev: GroupMessage) -> None:
        """自己人在群里说话 → 后台看一下是不是在回客户，是就记进记忆（memory.capture）。不挡别的"""
        from .listen import flatten

        body, reply_to = flatten(ev)
        if ev.at_me or not body or body.startswith("/") or ev.group_id == settings.report_group:
            return
        t = asyncio.create_task(memory.capture(
            store, llm, judge_llm, group_id=ev.group_id, staff_id=ev.user_id, staff_name=ev.sender_name,
            body=body, reply_to=reply_to, message_id=ev.message_id,
        ), name="learn-staff-reply")
        learn_tasks.add(t)
        t.add_done_callback(learn_tasks.discard)

    async def staff_present(g: int) -> bool:
        """最近 STAFF_PRESENT_MINUTES 分钟里这个群有没有自己人说过话（机器人自己发的除外）。
        有就说明管理员在群里接着，没 @ 我的自动插话先让位。查不到就当没有，别耽误回复。"""
        try:
            now = datetime.now()
            since = (now - timedelta(minutes=STAFF_PRESENT_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
            rows = await asyncio.to_thread(store.group_msgs_recent, g, since, 60)
            staff_ids = await staff()
            return any(r["user_id"] in staff_ids for r in rows)
        except Exception:
            return False

    async def auto_answer(ev: GroupMessage, body: str) -> bool:
        """没 @ 我的一句话：**像问句**就往下判 —— 命中标准答案就当场回，只是沾边就交给正式答题路。

        **不抛异常、没把握就不出声。** 返回 True = 沾边，调用方当成 @ 我的问题往下走
        （查资料、各道闸、答不上来叫人）。

        2026-10-16 砍过一轮（管理员：「判断条件太多了…把误伤的都删除掉」）：去掉两道模型判断
        （「看上下文判是不是在问客服」），改成正则判像不像问句；门槛并成 `KB_HIT_SCORE` 一个数。
        """
        g, u = ev.group_id, ev.user_id
        if g == settings.report_group or await handoffs.is_staff(u):
            return False
        # 管理员（自己人）最近在这个群里说过话 → 不插嘴（2026-10-19 管理员定的）：
        # 真机 12:03 小开心在群里回客户「下次早点申请」，12:05 客户再追问，
        # 机器人还插一句「已叫人了」并开会话 —— 管理员都接手了，机器人该让位。
        # 只拦「没 @ 我」的自动插话：客户明确 @ 我照常回
        if await staff_present(g):
            return False
        # 客户之间正你来我往地聊 → 这段不是问我们的，别插话（2026-10-26 管理员的要求）。
        # **必须在算向量、命中标准答案之前**：一旦命中就发，等于还是插进了人家的话里
        if await peers_chatting(g, u, int(ev.message_id or 0)):
            log.info("群 %s｜%s 在跟别的客户聊，这句「%.30s」不插话", g, ev.sender_name, body)
            return False
        q = memory.clean(body)
        if len(q) < AUTO_MIN_CHARS or len(q) > MAX_QUESTION:
            return False
        # **像问句才接**（2026-10-16 换的）：原来这一步是让模型判「是不是在问客服」，
        # 它误判过、还每条消息多花一次调用。「像不像问句」用正则（跟盯群同一把尺）就够：
        # 「我已经充值好了哈」这种既没有问号也没有疑问词的，照样不接
        if not (_QUESTION.search(q) or _TROUBLE.search(q)):
            return False
        # 在跟别人说话：@ 了别人
        if any(s.get("type") == "at" and str((s.get("data") or {}).get("qq")) != str(ev.self_id) for s in ev.message):
            return False
        if crisis_hit(q) is not None or topic(q) is not None or looks_like_refund(q):
            # **交给正式那条路，不再一声不吭**（2026-11-09）。真机：客户在售后群问「能退款吗」，
            # 没 @ 我 → 这里静默返回 → 客户什么都没收到，两分钟后管理员自己进来回。
            # 正式路对这三类各有各的处理：危机发关心的话并叫超管、红线回固定话术、
            # 退款发退款话术并转人工（见 on_group 里 crisis/topic/handle_human）。
            log.info("群 %s｜%s 没 @ 我「%.30s」是危机/红线/退款类 → 交正式路处理", g, ev.sender_name, q)
            return True
        if await handoffs.silenced(g, u):
            return False
        now_m = time.monotonic()
        # 冷却跟 @ 我那条路同一个数（2026-10-16：原来这里另要 60 秒，同一个人的第二句会被丢掉）
        if now_m - auto_last.get((g, u), -settings.qa_cooldown - 1) < settings.qa_cooldown:
            return False
        try:
            now = datetime.now()
            rows = await asyncio.to_thread(store.group_msgs_recent, g, (now - timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S"), 40)
            from .listen import flatten

            reply_to = flatten(ev)[1]
            # 引用的是群里别人的话（机器人自己的话不进 group_msgs）→ 在跟那个人说话
            if reply_to and any(r["message_id"] == reply_to and r["user_id"] != u for r in rows):
                return False
            vec = await llm.embed_one(q)
            price, invoice = looks_like_price(q), looks_like_invoice(q)
            text, src, entry_id, mem = "", "", None, None
            hit = await answerer.retriever.best_entry(q, vec)
            if hit and hit.score >= settings.kb_hit_score:
                entry = await asyncio.to_thread(store.get_entry, hit.entry_id)
                if entry is not None:
                    text, src, entry_id = entry.answer, SRC_KB, entry.id
            if not text and not (price or invoice):
                # 价格、发票只认他亲笔写进标准答案的；群里随口报过的价可能早就变了
                got = await memory.recall(store, vec, memory.MEMORY_SCORE)
                if got is not None:
                    mem = got[0]
                    text, src = mem["answer"], SRC_MEMORY
            if not text:
                # 没命中：**沾边就交给正式应答路**（查资料 → 资料也没有就叫同事）。
                # 2026-10-16 起不再让模型判「这是不是在问客服」—— 那道判断把答得了的答案判掉过
                # （真机：「为什么只能用国内大模型了」，只看第一名 #81 判 NO，其实 #11 答得了），
                # 而且每条没 @ 我的消息都要多花一次调用。真问句该不该接，由「像问句」+
                # 「库里有没有像的东西」两个便宜的判断说了算。
                # 价格 / 发票不走这条（没 @ 我的照旧只认他亲笔写的标准答案）
                if hit and hit.score >= settings.kb_near_score and not (price or invoice):
                    # 客户之间在聊（这条之后别的客户已经接话了）→ 现在就别接，省下那十秒查资料
                    # （真机 19:10：查完才发现人家早聊过去了，答案发也不是、不发也不是）
                    if await peers_cut_in(ev, int(ev.message_id or 0)):
                        log.info("群 %s｜%s 没 @ 我「%.30s」，但别的客户已经接话了 → 不当成问我们",
                                 g, ev.sender_name, q)
                        return False
                    auto_last[(g, u)] = now_m
                    log.info("群 %s｜%s 没 @ 我「%.30s」：沾边 #%d（%.3f）→ 当成 @ 我，去查资料答",
                             g, ev.sender_name, q, hit.entry_id, hit.score)
                    return True
                return False
            if auto_what.get((g, u)) == text:
                return False
            # 客户之间在聊：这条之后别的客户已经接话了 → 不插嘴（2026-10-16：19:10 那个话茬）
            if await peers_cut_in(ev, int(ev.message_id or 0)):
                log.info("群 %s｜%s 没 @ 我「%.30s」，但别的客户已经接话了 → 不插嘴", g, ev.sender_name, q)
                return False
            # **调模型之前先登记这句问题**：客户常见「先发问题 → 再单独 @ 我一下」，
            # 那条 @ 会走主路，登记了它就知道这句已经在答，不会重复回（2026-10-16）
            auto_asked[(g, u)] = q
            if entry_id is not None:
                # 走正式那条路发：价格 / 发票同类闸、低分复核、命中计数、问题类都在 entry_only 里
                same: Callable[[str], bool] = looks_like_price if price else looks_like_invoice if invoice else (lambda _p: True)
                got_e = await answerer.entry_only(q, same, min_score=0.0, why="没 @ 我的问题", judge_on_error=False)
                if got_e is None:
                    auto_asked.pop((g, u), None)  # 没发出去，撤销登记
                    return False
                text, src, entry_id = got_e.text, got_e.source, got_e.entry_id
                score, cid, ms = got_e.score, got_e.cluster_id, got_e.elapsed_ms
            else:
                score, cid, ms = 0.0, None, 0
                await asyncio.to_thread(store.use_memory, mem["id"])
            auto_last[(g, u)] = now_m
            auto_what[(g, u)] = text
            answered_at[(g, u)] = time.monotonic()
            log.info("群 %s｜%s 没 @ 我，%s，直接回：%.40s", g, ev.sender_name,
                     f"命中标准答案 #{entry_id}" if entry_id else f"照管理员答过的（记忆 #{mem['id']}，{mem['staff_name']}）", q)
            await say(g, text, mention=u, chunk=True, by_para=True, quote=int(ev.message_id or 0))
            if entry_id is not None:
                await send_entry_images(g, entry_id)
            await asyncio.to_thread(
                store.log, group_id=g, user_id=u, nickname=ev.sender_name, question=q, answer=text,
                source=src, score=score, entry_id=entry_id, cluster_id=cid, elapsed_ms=ms,
            )
        except Exception:  # noqa: BLE001 —— 自动回复出任何错都当没命中，不能把群消息处理搞崩
            log.warning("没 @ 我的自动回复出错，这句不回", exc_info=True)

    async def who_asked(ev: GroupMessage, question: str) -> tuple[relay.Asker, list[str]]:
        """这次问题算谁问的 + 要看的截图地址。见 relay.py 第 1、2 条。**不抛异常**：出错就当他自己问的"""
        me = relay.Asker(ev.user_id, ev.sender_name, question)
        urls = relay.image_urls(ev.message)
        try:
            is_staff = ev.user_id in await staff()
            rid = relay.reply_id(ev.message)
            if is_staff and rid:
                # 引用转述：问题取被引用那条（它的图也算）
                got = await client.call_api("get_msg", message_id=rid)
                segs = got.get("message") if isinstance(got, dict) else None
                uid = int((got or {}).get("user_id") or 0)
                if isinstance(segs, list) and uid and uid != ev.self_id and uid not in await staff():
                    sender = got.get("sender") or {}
                    nick = sender.get("card") or sender.get("nickname") or str(uid)
                    q = relay.merge_relayed(relay.plain(segs), question)
                    log.info("%s 引用转述 %s 的话：%.40s", ev.sender_name, nick, q)
                    return relay.Asker(uid, nick, q, relayed_by=ev.user_id), relay.image_urls(segs) + urls
            if is_staff and not rid:
                # 原样复制转述：在这个群最近的客户消息里找原话
                since = (datetime.now() - timedelta(minutes=relay.RELAY_WINDOW)).strftime("%Y-%m-%d %H:%M:%S")
                recent = await asyncio.to_thread(store.group_msgs_recent, ev.group_id, since)
                orig = relay.find_original(question, recent, staff=await staff())
                if orig:
                    log.info("%s 转述 %s 的原话：%.40s", ev.sender_name, orig[1], question)
                    return relay.Asker(orig[0], orig[1], question, relayed_by=ev.user_id), urls
        except (ApiError, ConnectionError, Exception) as e:  # noqa: BLE001
            log.warning("判断是不是转述出错，当他自己问的：%s", e)
        return me, urls

    async def read_screen(data: bytes, mime: str) -> str | None:
        """看一张截图。VISION_MODEL 回「模型不存在」就换 VISION_FALLBACK_MODEL 再看一次；都看不成返回 None（当没图）。

        2026-10-10 的日志：qwen3.7-plus 在 LLM_* 那组 404「当前分组不可用」，从 00:04 到 16:12 每张截图都当没图，
        只有一行 WARNING，客户和超管都不知道机器人没看图。**只在 ModelMissing 时换**：超时、5xx 是临时的，
        换个模型再看一次只是让客户多等一轮（看一张 5~40 秒）。两个都不存在时私聊超管一次（`vision_alerted`），
        别等哪天有人翻日志才发现
        """
        nonlocal vision_alerted
        tried: list[str] = []
        for model in dict.fromkeys(m for m in (settings.vision_model, settings.vision_fallback_model) if m):
            tried.append(model)
            try:
                seen = await llm.read_image(data, mime, model=model, prompt=relay.SCREENSHOT_PROMPT)
            except ModelMissing as e:
                log.warning("看截图：%s 在当前分组不存在（%.80s），换下一个看图模型", model, e)
                continue
            except LLMError as e:
                log.warning("看截图失败（%s），当没图：%s", model, e)
                return None
            if len(tried) > 1:
                log.info("看截图：%s 不可用，用备用 %s 看的。VISION_MODEL 该改了", tried[0], model)
            return seen
        log.error("看截图：%s 都在当前分组不存在，截图一律当没图。检查 VISION_MODEL / VISION_FALLBACK_MODEL 和 LLM_* 的 key",
                  " / ".join(tried))
        now = time.monotonic()
        if now - vision_alerted > VISION_ALERT_EVERY:
            vision_alerted = now
            await notify_admins(
                f"⚠️ 看图模型不可用：{' / '.join(tried)} 在 LLM_* 那组 key 下都回「模型不存在」\n"
                f"客户发的截图现在一律当没图答。改 .env 的 VISION_MODEL（或 VISION_FALLBACK_MODEL）后重启机器人。\n"
                f"{VISION_ALERT_EVERY // 3600} 小时内不重复私聊，详情看 logs/bot.log"
            )
        return None

    async def screens_of(
        ev: GroupMessage, asker: relay.Asker, urls: list[str], question: str,
    ) -> tuple[list[str], int]:
        """把截图转成文字，顺带告诉调用方**有几张没看成**。

        返回（读出来的文字, 没看成的张数）。没看成 = fetch_image 拿不到 / read_screen 返回 None；
        判成「无关」的不算没看成（图打开了，只是跟问题不沾边，不能跟客户说没打开）。
        这条没图、问题又短（「这个咋回事」「还是一样」）就看同一个人刚发的图 ——
        先发图、再 @我 问是常见的。问题长的不去翻：自己说清楚了，翻出来的图多半不相干。**不抛异常**
        """
        failed = 0
        try:
            if not urls and len(question) <= relay.FOLLOW_MAX_LEN:
                since = (datetime.now() - timedelta(minutes=relay.IMAGE_WINDOW)).strftime("%Y-%m-%d %H:%M:%S")
                recent = await asyncio.to_thread(store.group_msgs_recent, ev.group_id, since, 20)
                mids = [int(m["message_id"]) for m in recent if m["user_id"] == asker.user_id and "[图片]" in m["body"]]
                for mid in mids[: relay.MAX_IMAGES]:
                    got = await client.call_api("get_msg", message_id=mid)
                    urls += relay.image_urls((got or {}).get("message") or [])
            out = []
            for url in urls[: relay.MAX_IMAGES]:
                img = await relay.fetch_image(url)
                if img is None:
                    failed += 1
                    continue
                seen = await read_screen(img[0], img[1])
                if seen is None:
                    failed += 1
                    continue
                if seen.strip().strip("。.") == relay.IRRELEVANT:
                    log.info("%s 的截图跟问题不沾边，当没图", asker.nickname)
                    continue
                out.append(seen)
            if out:
                log.info("看了 %s 的 %d 张截图", asker.nickname, len(out))
            return out, failed
        except Exception:  # noqa: BLE001
            # 已经拿到几个地址就有几张没看成（一张都还没拿到就是 0）。
            # 这里不返回 0：出错的后果是客户看不见他发的图，必须让模型知道
            log.warning("取截图出错，当没图", exc_info=True)
            return out if "out" in locals() else [], len(urls)

    async def thread_of(ev: GroupMessage, asker: relay.Asker, question: str) -> tuple[str, str, bool]:
        """拼这个客户的「最近对话」。返回（给模型看的几行, 同事说过的原话, 最近有没有发文件）。

        2026-10-23 加：模型以前只看得到「客户这一句 + 上一句问的是」，看不到客户前面贴过的
        报错、也看不到自己上一条回了什么。结果客户刚贴完报错它说「看不到内容」；
        客户说「还是不行」，它把「换一个节点」原样又发一遍。这里把三样拼起来：
        - 客户自己 15 分钟内的发言（`collect_run` 已经并进 question 的那几条要排掉，否则重复）
        - 同事回过他的（引用了他某条消息，或者正文里 @ 了他）
        - 机器人自己 qa_log 里的回答（去掉 `[看了截图]`/`[拦下]`/`[依据]` 这些备注行）

        **任何异常都返回空并记日志，绝不影响回答。** 拼不出上下文顶多回到改之前的样子，
        不能因为它把本来能答的变成转人工。
        """
        try:
            now = datetime.now()
            since = (now - timedelta(minutes=relay.THREAD_WINDOW)).strftime("%Y-%m-%d %H:%M:%S")
            msgs = await asyncio.to_thread(store.group_msgs_recent, ev.group_id, since, 60)
            # 客户自己的 message_id 集合：同事引用回复他的那条才算「在跟他说」
            asker_mids = {
                int(m["message_id"] or 0) for m in msgs
                if int(m["user_id"] or 0) == asker.user_id and int(m["message_id"] or 0)
            }
            qflat = " ".join(question.split())
            items: list[tuple[str, str, str]] = []
            staff_said: list[str] = []
            for m in msgs:  # 新的在前，format_thread 会按时间排回去
                uid = int(m["user_id"] or 0)
                mid = int(m["message_id"] or 0)
                body = str(m["body"] or "")
                if uid == asker.user_id:
                    if mid == int(ev.message_id or 0):
                        continue
                    # 已经并进 question 的那几条：再放进 thread 就是同一句说两遍
                    flat = " ".join(body.split())
                    if flat and flat in qflat:
                        continue
                    items.append((str(m["created_at"]), "客户", body))
                elif m["role"] == ROLE_STAFF and uid != asker.user_id:
                    rt = int(m["reply_to"] or 0)
                    if rt not in asker_mids and f"@{asker.nickname}" not in body:
                        continue
                    nick = str(m["nickname"] or "").strip()
                    items.append((str(m["created_at"]), f"同事{nick}", body))
                    staff_said.append(body)
            answers = await asyncio.to_thread(store.recent_answers, ev.group_id, asker.user_id, since)
            for a in answers:
                text = relay.clean_logged_answer(str(a["answer"] or ""))
                if text:
                    items.append((str(a["created_at"]), "你（机器人）", text))
            # 这条消息自己带文件段，或者他 5 分钟内发过「[文件]」（跟截图同一个窗口）
            has_file = any(str(seg.get("type")) == "file" for seg in ev.message)
            if not has_file:
                fsince = (now - timedelta(minutes=relay.IMAGE_WINDOW)).strftime("%Y-%m-%d %H:%M:%S")
                recent = await asyncio.to_thread(store.group_msgs_recent, ev.group_id, fsince, 60)
                has_file = any(
                    int(r["user_id"] or 0) == asker.user_id and "[文件]" in str(r["body"] or "")
                    for r in recent
                )
            return relay.format_thread(items), "\n".join(staff_said), has_file
        except Exception:  # noqa: BLE001 —— 上下文拼不出来也要能答，退回改之前的样子
            log.warning("拼最近对话出错，这次不带对话上下文", exc_info=True)
            return "", "", False

    async def say(
        group_id: int,
        body: str,
        *,
        mention: int | None = None,
        chunk: bool = False,
        by_para: bool = False,
        quote: int = 0,
    ) -> None:
        """发群消息。array 格式的 text 段，模型吐出 [CQ:at,qq=all] 也不会被当成真的 @全体。

        `chunk=True` 才分段，**默认不分**。固定话术（HUMAN_TEXT / REFUND_TEXT /
        PRICE_TEXT / INVOICE_TEXT / handoff_text / DECLINE / 寒暄）本来就是一句话，
        切它没意义，只有真答案走分段。

        **段数上限和段间隔是风控给的，不是排版给的。** 这个 QQ 号三秒内往一个群
        连发四五条是典型刷屏特征，而它挂在五个真客户群里——被限制发言等于五个群
        同时哑掉。所以间隔随机 1.2~2.0 秒（不是固定值，固定节奏本身就像机器），
        段数默认封在 3。

        `@` 只加第一段：后面几段再 @ 一遍，群里看着像在喊人。
        `quote`：第一段引用这条消息（message_id）。没 @ 我、隔了十分钟才答的那种要带，不然客户不知道答的是哪句
        """
        body = clean_for_chat(body)
        pieces = (
            split_reply(
                body, limit=settings.reply_segments, by_para=by_para, single_max=settings.reply_single_max
            )
            if chunk
            else [body]
        )
        if len(pieces) > SEND_MAX_PIECES:
            # 2026-10-27：一条 800 字的标准答案切成 10 个气泡刷屏（管理员「为什么回复那么多」）。
            # 一次最多发这么多条；后面的不发，记日志 —— 正常应该在答案那一步就挑短了（Answerer._pick）
            log.warning("群 %s 一条回复切成了 %d 段，只发前 %d 段：%.40s", group_id, len(pieces), SEND_MAX_PIECES, body)
            pieces = pieces[:SEND_MAX_PIECES]
        for i, piece in enumerate(pieces):
            if i:
                await asyncio.sleep(typing_delay(piece, settings.reply_gap_min, settings.reply_gap_max))
            segs = [at(mention), text(" " + piece)] if (mention and i == 0) else [text(piece)]
            if quote and i == 0:
                segs = [quote_seg(quote), *segs]
            err: Exception | None = None
            for attempt, wait in enumerate((0.0, *SEND_BACKOFF), start=1):
                if wait:
                    await asyncio.sleep(wait)  # 退避：超时/限流这类等一下再试
                try:
                    await client.send_group_msg(group_id, segs)
                    err = None
                    break
                except (ApiError, ConnectionError) as e:
                    err = e
                    if unlinked(segs) is not segs:
                        log.info("群 %s 带链接的回复没发出去，下一次去掉 https:// 再发", group_id)
                        segs = unlinked(segs)
                    log.warning(
                        "群 %s 回复失败（第 %d/%d 段，第 %d/%d 次，%d 字）：%s",
                        group_id, i + 1, len(pieces), attempt, SEND_TRIES, len(piece), e,
                    )
            if err is not None:
                # **重试也没发出去 → 出声，别静默丢。** 中途失败就不再发后面的段：
                # 后几段单独到达是没头没尾的碎话（这条规矩 2026-09-24 定的，不动）。
                # 客户那边什么都没收到，只有超管知道 —— 把内容一起私聊给他，他能手打补发
                log.error("群 %s 第 %d/%d 段三次都没发出去，放弃：%s", group_id, i + 1, len(pieces), err)
                try:
                    await notify_admins(
                        f"⚠️ 群 {group_id} 有一条回复没发出去（第 {i + 1}/{len(pieces)} 段，"
                        f"{len(piece)} 字，{SEND_TRIES} 次都失败）：{err}\n"
                        f"客户什么都没收到。内容：\n{piece[:200]}\n（要补发就复制过去，或者让我重发）"
                    )
                except Exception:  # noqa: BLE001 —— 通知也失败就只剩日志了，别把处理搞崩
                    log.warning("回复失败之后私聊超管也失败", exc_info=True)
                return

    async def send_entry_images(group_id: int, entry_id: int) -> None:
        """标准答案在后台配了图，文字发完接着发图。

        一张图一条消息，间隔跟分段一样随机停一下（理由见 say 的风控说明）。
        图片用 base64 发，不用 file:// 路径：NapCat 在容器里，看不到宿主机的文件。
        """
        images = await asyncio.to_thread(store.entry_images, entry_id)
        for _, fname in images:
            path = KB_IMAGE_DIR / fname
            try:
                data = await asyncio.to_thread(path.read_bytes)
            except OSError as e:
                log.warning("答案 #%d 的附图 %s 读不了：%s", entry_id, fname, e)
                continue
            lo, hi = settings.reply_gap_min, settings.reply_gap_max
            await asyncio.sleep(random.uniform(min(lo, hi), max(lo, hi)))
            for attempt, wait in enumerate((0.0, *SEND_BACKOFF), start=1):
                if wait:
                    await asyncio.sleep(wait)
                try:
                    await client.send_group_msg(group_id, [image_b64(data)])
                    break
                except (ApiError, ConnectionError) as e:
                    log.warning(
                        "群 %s 发答案 #%d 的附图失败（第 %d/%d 次）：%s",
                        group_id, entry_id, attempt, SEND_TRIES, e,
                    )
            else:
                await notify_admins(f"⚠️ 群 {group_id} 答案 #{entry_id} 的附图 {fname} 没发出去（试了 {SEND_TRIES} 次）")
                return

    async def tell(user_id: int, body: str) -> None:
        try:
            await client.send_private_msg(user_id, [text(body)])
        except (ApiError, ConnectionError) as e:
            log.warning("私聊通知超管 %s 失败：%s", user_id, e)

    async def notify_admins(body: str) -> None:
        """要管理员接手的事私聊他。

        群里发的是给客户看的安抚话术，私聊发的是给他看的工单。
        两个收件人、两种内容，别合成一条。
        """
        for admin in settings.super_admins:
            await tell(admin, body)

    async def order_no_in_recent(ev: GroupMessage, question: str) -> bool:
        """他刚是不是已经把订单号贴出来了。**只认他自己发的** —— 同事在群里念单号是干活。

        查两处：这句话本身，以及最近 `ORDER_LOOKBACK_MINUTES` 分钟他在这个群说的话。
        后者是给「先贴号、隔一句才说想退款」这种情况用的（2026-10-20 真机就是这样）。
        查不通就当没贴过，退回原来那版话术 —— 多问一句订单号不致命，卡住不回才致命。
        """
        if has_order_no(question, settings.approval_answer_prefix):
            return True
        try:
            since = datetime.now() - timedelta(minutes=ORDER_LOOKBACK_MINUTES)
            rows = await asyncio.to_thread(
                store.group_msgs_recent, ev.group_id, since.strftime("%Y-%m-%d %H:%M:%S"), 40,
            )
        except Exception:  # noqa: BLE001
            return False
        pat = order_re(settings.approval_answer_prefix)
        if pat is None:
            return False
        return any(
            str(r["user_id"]) == str(ev.user_id) and pat.search(r["body"] or "")
            for r in rows
        )

    async def handle_refund(ev: GroupMessage, question: str) -> None:
        log.info("群 %s 的 %s 提到退款，转人工：%.40s", ev.group_id, ev.sender_name, question)
        # 订单号他已经给了就别再要一遍（2026-10-20 大哥要求，见 REFUND_TEXT_WITH_ORDER 上面那段）
        text = REFUND_TEXT_WITH_ORDER if await order_no_in_recent(ev, question) else REFUND_TEXT
        await say(ev.group_id, with_hours(text), mention=ev.user_id, quote=int(ev.message_id or 0))
        row = await handoffs.open(ev, question, R_REFUND)
        await notify_admins(
            f"📨 退款要你接手\n群：{ev.group_id}\n客户：{ev.sender_name}（{ev.user_id}）\n"
            f"原话：{question}\n\n群里已经回了安抚话术，没有承诺能退。" + tag(row)
        )
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=text, source=SRC_HUMAN,
        )

    async def handle_human(ev: GroupMessage, question: str) -> None:
        """客户点名要人工。**不查资料、不调模型**，回一句就去叫人。

        记 `SRC_HUMAN`，跟退款同一个源：对账上它俩是一回事 ——「AI 全程没参与，
        这件事落到人头上了」。`day_stats()` 因此一个字都不用动。

        **群里那句话术按 `HANDOFF_REPLY_COOLDOWN` 降噪，私聊和会话状态不受影响**
        （2026-09-24 管理员加的，起因是不 @ 也能喊人工之后门槛低了，「我找人工问一下」
        这种话在群里随口说说也会触发）。三件事拆开对待：
        - **会话必须先开**：`/会话` 里要看得到这个人，不能因为压了话术就连会话也不开
        - **私聊照发，不受这道冷却管**：私聊是他看群里出事的唯一窗口，客户没多久
          又喊一次人工往往是升级（第一句「转人工」，第二句「等了半天没人」），
          压掉群里那句只是不刷屏，压掉私聊就是把升级信号吃了。宁可他多收一条，不可漏一条
        - **压掉的那次不写 `store.log`**：机器人没开口，写一条 `SRC_HUMAN` 会让日报
          的「转人工」数虚高——跟 `SRC_HOLDING` 单独分出来是同一类错，账要对得上
        """
        log.info("群 %s 的 %s 点名要人工：%.40s", ev.group_id, ev.sender_name, question)
        row = await handoffs.open(ev, question, R_HUMAN)

        key = (ev.group_id, ev.user_id)
        now = time.monotonic()
        prev = human_replied.get(key)
        cooldown = settings.handoff_reply_cooldown
        suppressed = prev is not None and cooldown > 0 and now - prev < cooldown
        if suppressed:
            log.info(
                "%s 在群 %s 刚喊过要人工，群里话术压了（还差 %.0f 秒），私聊照发",
                ev.sender_name, ev.group_id, cooldown - (now - prev),
            )
        else:
            human_replied[key] = now
            await say(ev.group_id, with_hours(HUMAN_TEXT), mention=ev.user_id, quote=int(ev.message_id or 0))
            await asyncio.to_thread(
                store.log,
                group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
                question=question, answer=HUMAN_TEXT, source=SRC_HUMAN,
            )

        group_note = "刚才在这个群喊过，群里这次没再回一遍（降噪）。" if suppressed else "群里已经回了「已经叫人了」。"
        await notify_admins(
            f"📨 客户点名要人工\n群：{ev.group_id}\n客户：{ev.sender_name}（{ev.user_id}）\n"
            f"原话：{question}\n\n{group_note}" + tag(row)
        )

    async def from_entry(ev: GroupMessage, question: str, kind: str, same_topic: Callable[[str], bool]) -> bool:
        """价格 / 发票类问题先查标准答案，命中就照原文回、不转人工。返回回了没有。

        2026-09-28 管理员定的：「命中你写的标准答案就照着回，没命中还是转人工」。
        起因是 #3（专票怎么开）自打发票闸上线就一次没触发过 —— 闸排在问答前面，
        他亲笔写过的答案也到不了客户那里。**只认标准答案，不查资料**，见 Answerer.entry_only
        """
        reply = await answerer.entry_only(question, same_topic)
        if reply is None:
            return False
        log.info("群 %s 的 %s 问了%s，命中标准答案 #%s，照着回", ev.group_id, ev.sender_name, kind, reply.entry_id)
        await say(ev.group_id, reply.text, mention=ev.user_id, chunk=True, by_para=True)
        if reply.entry_id is not None:
            await send_entry_images(ev.group_id, reply.entry_id)
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=reply.text, source=reply.source, score=reply.score,
            entry_id=reply.entry_id, cluster_id=reply.cluster_id, elapsed_ms=reply.elapsed_ms,
        )
        return True

    async def from_notice(ev: GroupMessage, question: str) -> bool:
        """有生效中的 /口径、而且这句跟它有关 → 照口径原话回。返回回了没有（bot/kb/notice.py）。
        没口径的时候只读一下 meta 表，不调模型"""
        n = await asyncio.to_thread(notice.current, store)
        if n is None or len(question) < MIN_QUESTION or not await notice.related(llm, n, question):
            return False
        log.info("群 %s 的 %s 问的跟口径有关，照口径回：%.40s", ev.group_id, ev.sender_name, question)
        # n.outgoing = 该发给客户的那句：「条件→回复」只发后半句，普通口径就是原话（notice.py）
        await say(ev.group_id, n.outgoing, mention=ev.user_id, quote=int(ev.message_id or 0))
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=n.outgoing, source=SRC_NOTICE,
        )
        return True

    async def handle_price(ev: GroupMessage, question: str) -> None:
        """沾价格：命中标准答案照着回，没命中转人工。**模型一个数字都不许说。**"""
        if await from_entry(ev, question, "价格", looks_like_price):
            return
        log.info("群 %s 的 %s 问了价格，转人工：%.40s", ev.group_id, ev.sender_name, question)
        await say(ev.group_id, with_hours(PRICE_TEXT), mention=ev.user_id, quote=int(ev.message_id or 0))
        row = await handoffs.open(ev, question, R_PRICE)
        await notify_admins(
            f"📨 价格问题要你接手\n群：{ev.group_id}\n客户：{ev.sender_name}（{ev.user_id}）\n"
            f"原话：{question}\n\n群里已经回了转人工，没报任何数字。"
            f"常问的可以写成标准答案，下次命中就照着回，不用再叫你。" + tag(row)
        )
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=PRICE_TEXT, source=SRC_HUMAN,
        )

    async def handle_invoice(ev: GroupMessage, question: str) -> None:
        """沾发票：命中标准答案照着回，没命中转人工。**模型不说能不能开，也不说几个点。**"""
        if await from_entry(ev, question, "发票", looks_like_invoice):
            return
        log.info("群 %s 的 %s 问了发票，转人工：%.40s", ev.group_id, ev.sender_name, question)
        await say(ev.group_id, with_hours(INVOICE_TEXT), mention=ev.user_id, quote=int(ev.message_id or 0))
        row = await handoffs.open(ev, question, R_INVOICE)
        await notify_admins(
            f"📨 发票问题要你接手\n群：{ev.group_id}\n客户：{ev.sender_name}（{ev.user_id}）\n"
            f"原话：{question}\n\n群里已经回了转人工，没说能不能开。"
            f"常问的可以写成标准答案，下次命中就照着回，不用再叫你。" + tag(row)
        )
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=INVOICE_TEXT, source=SRC_HUMAN,
        )

    async def handle_holding(ev: GroupMessage, question: str) -> None:
        """人工接管中。**只回那一句，每次都回：不查资料、不调模型、不私聊、不受冷却管。**

        不私聊是因为人已经在群里了，他看得见。记 `SRC_HOLDING`，不记 human ——
        理由见 store.SRC_HOLDING（不能让日报的数字虚高）。
        """
        log.info("群 %s 的 %s 正被人工接管，回稍等：%.40s", ev.group_id, ev.sender_name, question)
        await say(ev.group_id, settings.handoff_text, mention=ev.user_id, quote=int(ev.message_id or 0))
        # 他还在等，这算动静：没动静自动关的计时从这一刻重新算
        await handoffs.touched(ev.group_id, ev.user_id)
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=settings.handoff_text, source=SRC_HOLDING,
        )

    async def handle_blocked(ev: GroupMessage, question: str, kind: str) -> None:
        """碰了不聊的话题。**回一句就完：不查资料、不调模型、不记待办、不通知超管。**

        **为什么不通知超管**：退款要通知是因为那件事得有人接着办。红线话题
        没有「接着办」这一说 —— 半夜把一条涉黄原话私聊推给超管，除了让人
        不舒服没有任何用。要查有日志，`source=block` 一条 SQL 就捞出来了。
        """
        log.warning(
            "群 %s 的 %s 说了%s的内容，已挡：%.40s", ev.group_id, ev.sender_name, kind, question
        )
        await say(ev.group_id, DECLINE, mention=ev.user_id, quote=int(ev.message_id or 0))
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=DECLINE, source=SRC_BLOCK,
        )

    async def handle_crisis(ev: GroupMessage, question: str, word: str) -> None:
        """有人说了想不开的话。**回一句关心的话 + 开会话叫人，不查资料、不调模型。**

        **跟红线（handle_blocked）三处不一样**，每一处都是故意的：
        - **要通知超管。** 红线不通知是因为「没有接着办这一说」，这件事正相反，
          它唯一的出路就是有个人过来看一眼上下文 —— 是玩笑还是真的，机器判不了。
        - **要开转人工会话**（`R_CRISIS`）。私聊可能被他划过去，`/会话` 是能翻回来的账。
          开了会话**不等于机器人闭嘴**（只有 `taken` 才闭嘴），所以要是虚惊一场，
          客户接着问业务照样有人答。
        - **记 `SRC_HUMAN`**，跟退款/发票同一个源：对账上是同一件事 ——
          「AI 全程没参与，这件事落到人头上了」。`day_stats()` 一个字都不用动。

        **私聊里带上原话和命中的词。** 他要判断的第一件事是「这是真的吗」，
        而「跳楼」和「自杀」的可信度差得远，光说「有人说了想不开的话」他没法判。
        """
        log.warning(
            "群 %s 的 %s 说了想不开的话（命中「%s」）：%.40s",
            ev.group_id, ev.sender_name, word, question,
        )
        await say(ev.group_id, CARE, mention=ev.user_id, quote=int(ev.message_id or 0))
        row = await handoffs.open(ev, question, R_CRISIS)
        await notify_admins(
            f"⚠️ 有人说了想不开的话，你去看一眼\n群：{ev.group_id}\n"
            f"客户：{ev.sender_name}（{ev.user_id}）\n原话：{question}\n"
            f"（命中的词：{word}）\n\n"
            f"群里已经回了一句关心的话，带了心理援助热线 {HOTLINE}，没追问、没诊断。\n"
            f"**是不是真的只有你能判**——群里开玩笑说「这 bug 让我想跳楼」也会触发这条。"
            f"去翻一下前后几句再决定要不要私聊他。" + tag(row)
        )
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=CARE, source=SRC_HUMAN,
        )

    async def handle_smalltalk(ev: GroupMessage, question: str, kind: str) -> None:
        """寒暄。**不查资料、不记待办、不进命中率统计**（理由见 store.SRC_CHAT）。"""
        # 身份类分两次答（2026-10-16，见 smalltalk.IDENTITY 那段）：
        # 第一次只报名、把话头带回正事；**他再问一遍就照实说** —— 绕第二次就成骗人了
        straight = False
        if kind == smalltalk.IDENTITY:
            key = (ev.group_id, ev.user_id)
            now_m = time.monotonic()
            straight = now_m - id_asked.get(key, -IDENTITY_AGAIN - 1) <= IDENTITY_AGAIN
            id_asked[key] = now_m
        t0 = time.monotonic()
        body, by_model = await smalltalk.reply(llm, question, kind, straight=straight)
        await say(ev.group_id, body, mention=ev.user_id, quote=int(ev.message_id or 0))
        elapsed = int((time.monotonic() - t0) * 1000)
        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            question=question, answer=body, source=SRC_CHAT, elapsed_ms=elapsed,
        )
        log.info(
            "群 %s｜%s 寒暄「%.20s」→ %s%s（%.1fs）",
            ev.group_id, ev.sender_name, question, "模型" if by_model else "固定话术",
            "（身份第二次问，照实说）" if straight else "", elapsed / 1000,
        )

    async def answer_unasked(m: Mapping[str, Any]) -> bool:
        """盯群（kb/watch.py）发现的：没 @ 我、十分钟没自己人回的问题。**命中标准答案才答**，返回答了没有。

        09-30 管理员选的「不 @ 不插话」放宽版：十分钟没人回 + 命中标准答案，机器人就答。
        **只答标准答案原文**（他亲笔写的），不查资料、不让模型写一个字；门槛跟 @ 我时一个数
        （`KB_HIT_SCORE` —— 2026-10-16 并的，原来这里另要 0.85）。
        引用他那条再 @ 他，隔了十分钟，不引用他不知道答的是哪句。
        没答的（没命中、下面这几类）返回 False，盯群照旧私聊超管「有人问了没人回」
        """
        g, u = int(m["group_id"]), int(m["user_id"])
        q = " ".join(_AT_TEXT.sub(" ", str(m["body"]).replace("[图片]", " ")).split())
        if not settings.group_enabled(g) or g == settings.report_group:
            return False
        if len(q) < UNASKED_MIN_CHARS or len(q) > MAX_QUESTION or q.startswith("/"):
            return False
        # 要人去管的、机器人不该主动开口的，照旧交给人
        if crisis_hit(q) is not None or topic(q) is not None or wants_human(q) or looks_like_refund(q):
            return False
        if await handoffs.silenced(g, u):
            return False
        # 沾价格、发票的，那条标准答案自己也得是这类问题（跟 @ 我时同一道，见 Answerer.entry_only）
        same: Callable[[str], bool] = (
            looks_like_price if looks_like_price(q) else looks_like_invoice if looks_like_invoice(q) else (lambda _p: True)
        )
        # 这条消息前后他在跟别的客户聊 → 十分钟到了也别补答（2026-10-26）。
        # 用这条自己的时间：盯群可能晚几分钟才扫到，拿「现在」会把之后的话也算进来
        at = None
        try:
            at = datetime.strptime(str(m["created_at"]), "%Y-%m-%d %H:%M:%S")
        except (KeyError, TypeError, ValueError):
            at = None
        if await peers_chatting(g, u, int(m["message_id"] or 0), at=at):
            log.info("群 %s｜%s 那条没 @ 我的消息前后在跟别的客户聊，十分钟到了也不补答",
                     g, m["nickname"] or u)
            return False
        # judge_on_error=False：复核调用失败就不答。没人 @ 我，答错比不答贵（见 Answerer._addresses）
        got = await answerer.entry_only(
            q, same, min_score=0.0, why="没 @ 我的问题", judge_on_error=False,
        )
        if got is None:
            return False
        nick = str(m["nickname"] or u)
        log.info("群 %s 的 %s 没 @ 我、十分钟没人回，命中标准答案 #%s，引用他那条答：%.40s", g, nick, got.entry_id, q)
        await say(g, got.text, mention=u, chunk=True, by_para=True, quote=int(m["message_id"] or 0))
        if got.entry_id is not None:
            await send_entry_images(g, got.entry_id)
        await asyncio.to_thread(
            store.log,
            group_id=g, user_id=u, nickname=nick, question=q, answer=got.text, source=got.source,
            score=got.score, entry_id=got.entry_id, cluster_id=got.cluster_id, elapsed_ms=got.elapsed_ms,
        )
        return True

    async def look_back(ev: GroupMessage) -> tuple[str, int, str] | None:
        """单独 @ 我、没带字：翻**他自己**刚说的话，当成同一个问题。

        返回 (问题, 那条群消息 id, 原文)；翻不着返回 None。原文是拿来跟 `auto_what` /
        `pending_what` 比对的 —— 同一条别再答第二遍（2026-10-16 大哥的实测要求）。
        """
        since = (datetime.now() - timedelta(minutes=ASK_BACK_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
        rows = await asyncio.to_thread(store.group_msgs_recent, ev.group_id, since, 30)
        for r in rows:  # 新的在前
            if r["user_id"] != ev.user_id:
                continue
            raw = str(r["body"] or "")
            # 按同一把尺清（跟没 @ 我那条路的 memory.clean 一致），这样「刚答过没有」对得上
            body = memory.clean(_AT_TEXT.sub(" ", raw))
            if len(body) >= MIN_QUESTION and not body.startswith("/"):
                return body, int(r["message_id"] or 0), body
        return None

    async def collect_run(ev: GroupMessage, body: str) -> str | None:
        """客户连着发的好几条**并成一句问题**（2026-10-16）。

        做法是「等一小会儿」：第一条来了先记下、睡 `MERGE_WINDOW` 秒；这期间同一个人再发，
        就往这一堆里加（那边直接返回空串，不自己答）；醒来把这几条并成一句交给答题路。
        客户分几条打一句话在 QQ 上太常见（「开票咋开」+「公司抬头」+「多久能开好」）。

        返回 **None** = 我是跟班的，这一堆归领队那条管（调用方直接 return，别自己答）。
        （早先这里用空串当跟班信号，结果「只 @ 了张图、一个字没打」那种**空问题**也被当成跟班、
        整条不答了 —— 2026-10-16 试出来的，改成 None 才分得开。）
        **带图的那条不并**：图拼不进下一堆里，等这几秒反而把图错过了（图那条自己走）。
        **用换行拼**，不直接粘：这样跨条不会凑出「退款」「转人工」这种词，
        也就不会绕过上面那几道闸。
        """
        if relay.image_urls(ev.message) or not body.strip():
            return body  # 带图的、空问题的：自己走（不并，也不等）
        key = (ev.group_id, ev.user_id)
        pile = merging.get(key)
        if pile is not None:
            if len(pile) < MERGE_MAX and body not in pile:
                pile.append(body)
                log.info("群 %s｜%s 又发一条，并进这一堆（共 %d 条）：%.24s",
                         ev.group_id, ev.sender_name, len(pile), body)
            return None
        merging[key] = [body]
        try:
            await asyncio.sleep(MERGE_WINDOW)
            run = merging.get(key) or [body]
        finally:
            merging.pop(key, None)
        if len(run) == 1:
            return run[0]
        merged = "\n".join(run)[:MERGE_MAX_CHARS]
        log.info("群 %s｜%s 连着发了 %d 条，并成一句问：%.40s",
                 ev.group_id, ev.sender_name, len(run), merged.replace("\n", " / "))
        return merged

    async def peers_chatting(g: int, u: int, message_id: int, at: datetime | None = None) -> bool:
        """这个客户是不是**正跟别的客户你来我往地聊**。

        真机 2026-10-26 12:05，群 2000000003：岳和 Rei1 聊短视频聊了十分钟，两个人
        一句接一句，谁都没 @ 机器人。岳问「我怎么安装react+remotion」、Rei1 接
        「为什么不问问神奇的魔法海螺呢（」，机器人都当成问自己的，插了话、开了会话。
        管理员的要求：**他们俩在聊天，机器人就别插话。**

        判法纯看群消息，不问模型：取 CUT_IN_WINDOW 分钟内的群消息，
        去掉这一条本身、去掉这条之后才发的、去掉自己人（role=staff 或在 `staff()` 里），
        剩下的按先后排，只看「他」和「别的客户」两种发言人，数相邻换了几个。
        换满 `CHAT_SWITCHES` 次就算在聊。

        **先后按 group_msgs 自己的行号（id）排，不按 QQ 的 message_id**：message_id 不按时间递增，
        那段真机记录里依次是 3999990001、399999002、3999990002…… 拿它比大小，「这条之后」就是乱的。
        这条消息已经记进库了，就只看行号比它小的；还没记进来（记群消息是另一个处理器，先后不定），
        就看到 `at`（或现在）为止的全部。

        给了 `at` 就只看 `at` 往前 CUT_IN_WINDOW 分钟到 `at` 这一段（盯群补答要用
        那条消息自己的时间）；不给就是现在往前。任何异常都返回 False —— 宁可照旧，
        也不要因为读不到群消息把客户的问题吞掉。
        """
        try:
            end = at or datetime.now()
            since = (end - timedelta(minutes=CUT_IN_WINDOW)).strftime("%Y-%m-%d %H:%M:%S")
            until = end.strftime("%Y-%m-%d %H:%M:%S")
            rows = await asyncio.to_thread(store.group_msgs_recent, g, since, 80)
            staff_ids = await staff()
            own = [int(r["id"]) for r in rows if int(r["message_id"] or 0) == message_id]
            cut = own[0] if own else None
            seq: list[tuple[int, bool]] = []
            for r in rows:
                # 这条自己不算；这条之后才发的也不算（那时候话头已经过去了）
                if int(r["message_id"] or 0) == message_id:
                    continue
                if cut is not None and int(r["id"]) > cut:
                    continue
                if str(r["created_at"]) > until:
                    continue
                # 自己人说的话不进「客户之间」的序列：他 → 同事 → 他 只有他一个人在说
                if r["role"] == ROLE_STAFF or r["user_id"] in staff_ids:
                    continue
                seq.append((int(r["id"]), r["user_id"] == u))
            seq.sort()
            switches = sum(1 for a, b in zip(seq, seq[1:]) if a[1] != b[1])
            return switches >= CHAT_SWITCHES
        except Exception:  # noqa: BLE001 —— 读不到/数据坏了都按「没在聊」处理，别耽误回复
            log.warning("群 %s 判断是不是在跟别的客户聊时出错，按没在聊处理", g, exc_info=True)
            return False

    async def peers_cut_in(ev: GroupMessage, since_id: int) -> bool:
        """**这条问题之后，别的客户已经接话了吗**（2026-10-16）。

        客户之间聊天时机器人插嘴最讨嫌。真机（群 2000000003，19:10）：
        Rei1 说「gpt 免费的 c 端生图每天也有十张」，Карашников 追了一句「每天？」「按天的吗」——
        2 秒后 Rei1 自己回了「应用端啊」，机器人还在后面吭哧吭哧查资料，
        10 秒后照样把答案 + 一句反问发出来了：**那是插进人家的话茬里**，
        而且客户问的「按天的吗」根本不是问我们扣费方式。

        判法（纯看群消息，不问模型）：这条之后到我们发出去之前，
        **别的客户**说过话就算有人接话了。他自己接着说的、机器人自己发的、自己人说的都不算
        —— 自己人在场的规矩另有（handoff）。

        「这条之后」按 group_msgs 的行号算（2026-10-26 改）：原来拿 QQ 的 message_id 比大小，
        可它不按时间递增（见 peers_chatting），新的在前一条条往下翻、碰到一个比这条小的就停，停在哪全看运气。
        这条还没记进库就找不到起点，当没人接话（跟读不到库一样，宁可多答一句）。
        """
        since = (datetime.now() - timedelta(minutes=CUT_IN_WINDOW)).strftime("%Y-%m-%d %H:%M:%S")
        try:
            rows = await asyncio.to_thread(store.group_msgs_recent, ev.group_id, since, 40)
        except Exception:  # noqa: BLE001 —— 读不到就当没人接话，宁可多答一句
            return False
        own = [int(r["id"]) for r in rows if int(r["message_id"] or 0) == since_id]
        if not own:
            return False
        for r in rows:  # 新的在前
            if int(r["id"]) <= own[0]:
                break
            if r["user_id"] in (ev.user_id, ev.self_id) or r["role"] == ROLE_STAFF:
                continue
            return True
        return False

    def _group_lock(group_id: int) -> asyncio.Lock:
        """这个群的应答锁。没有就建一把（只在内存里，重启就清 —— 丢了就是少一次排队）"""
        lock = group_locks.get(group_id)
        if lock is None:
            lock = group_locks[group_id] = asyncio.Lock()
        return lock

    async def remind_one_at_a_time(ev: GroupMessage) -> None:
        """「一个一个来」那句话。**同一个人 60 秒内只说一次**：他连发三条问句就收三条「稍等」，
        比不说话更烦；一次都不说，他又会以为机器人卡死了"""
        key = (ev.group_id, ev.user_id)
        now_m = time.monotonic()
        if now_m - once_said.get(key, -ONCE_EVERY - 1) < ONCE_EVERY:
            return
        once_said[key] = now_m
        await say(ev.group_id, random.choice(ONCE_AT_A_TIME), mention=ev.user_id, quote=int(ev.message_id or 0))

    async def _take_turn(lock: asyncio.Lock) -> bool:
        """等这个群轮到我答。拿到返回 True（调用方自己 release）。

        **等过头返回 False**：那种情况就并着答了 —— 宁可偶尔交叉，也不能让谁的问题永远排不上
        """
        try:
            await asyncio.wait_for(lock.acquire(), QUEUE_MAX)
            return True
        except TimeoutError:
            log.warning("排队超过 %.0f 秒还没轮到，这条并着答", QUEUE_MAX)
            return False

    def _feedback_on_answer(ev: GroupMessage, body: str) -> str:
        """机器人 AFTER_ANSWER 秒内刚答过他，这句是不是对那次回答的反馈。
        返回 FB_GOOD / FB_BAD / 空串。**只读，不动状态**"""
        t = answered_at.get((ev.group_id, ev.user_id))
        if t is None or time.monotonic() - t > AFTER_ANSWER:
            return ""
        # 一边说一边 @ 了别人：那是在跟别人说
        if any(s.get("type") == "at" and str((s.get("data") or {}).get("qq")) != str(ev.self_id) for s in ev.message):
            return ""
        return feedback_kind(body)

    def _answering_ask(ev: GroupMessage) -> bool:
        """这句是不是在答机器人上一条反问（relay.py 第 4 条）。只读时间窗，不动状态。

        真正「用掉」这一笔是在下面带上下文那块（接完就 pop）：这里可能被调两次
        （判要不要落进正式应答路、判要不要带上一句），不能在这儿就把状态改了
        """
        t = asked_back.get((ev.group_id, ev.user_id))
        return t is not None and time.monotonic() - t <= relay.ASK_WINDOW * 60

    @dispatcher.on("message.group")
    async def on_group(ev: GroupMessage) -> None:
        nonlocal error_notified_at
        if not settings.group_enabled(ev.group_id):
            return
        if ev.user_id == ev.self_id:
            return  # 自己发的别再答一遍

        # 群里有人说话 = 转人工会话有动静（5 分钟没动静自动关，见 bot/handoff.py 开头）。
        # **不管 @ 没 @ 我**：同事跟客户你一句我一句的时候谁都不 @ 我
        await handoffs.activity(ev.group_id, ev.user_id)

        # 超管和自己人（同事）在群里开口可能是来接人的（算不算、接谁，见 bot/handoff.py）。
        # **排在「叫没叫我」前面**：他回客户不会 @我，放后面就永远看不到。
        # 看完照常往下走 —— 他要是 @我 提问，那是在测机器人，照答。
        # 同事接的：私聊发给同事本人，再抄一份给超管（编号要让兜底关会话的人看得见）
        if await handoffs.is_staff(ev.user_id):
            learn_staff_reply(ev)
            note = await handoffs.admin_spoke(ev)
            if note:
                await tell(ev.user_id, note)
                if ev.user_id not in settings.super_admins:
                    for admin in settings.super_admins:
                        await tell(admin, f"（{ev.sender_name} 在群里回客户）\n{note}")

        body = ev.plain_text.strip()
        # 这句是不是在答机器人上一条反问（relay.py 第 4 条，2026-10-16）。**@ 没 @ 都算**：
        # 有人答我上一条问出去的话，那就是接着那件事在说。只读时间窗，不动状态
        answering = bool(body) and not body.startswith("/") and _answering_ask(ev)
        # 这一条已经并过堆了没有（没 @ 我那条路先并就置 True，主路别再等一次）
        merged_done = False
        # 这条是不是**没 @ 我、被 auto_answer 放进正式应答路**的（2026-10-26）。
        # 只认 auto_answer 返回 True 这一条口子，**不要用 `not ev.at_me and not answering`
        # 去推断**：那样会把 `/问` 前缀、答我反问、喊人工这些也误标成「没 @ 我」，
        # 它们该照常出声。带这个标记的，没把握时一律不出声
        unasked = False
        # 答案引用哪条。默认就是当前这条；「单独 @ 我、翻上文」时改成引**问题那条**
        quote_id = int(ev.message_id or 0)
        prefix = settings.qa_prefix
        if body.startswith(prefix):
            question = body[len(prefix) :].strip()
        elif ev.at_me:
            question = body
        else:
            # 没叫我，不插话——**除了这两条**（2026-09-24 / 2026-10-16）。
            #
            # 第一条（2026-09-24 管理员定的）：**喊人工**。起因是真机：19:54:10 售前4 的李大伟
            # 在群里发「转人工」没 @，机器人一声不吭，两句话都没人接。**只放宽这一道闸**，
            # 退款/价格/发票/问答/寒暄一律照旧要 @——他只点了「转人工」，别顺手推广。
            #
            # 第二条（2026-10-16）：**客户在答我上一条反问**。真机那个样子：客户问「连不上」，
            # 机器人答「一般是地址或密钥填错了，你先对一下。你用的哪个客户端？」，
            # 客户回「cherry studio」没 @ 我 —— 这句既不像追问（13 个字、不带「那/呢」），
            # 也没 @我，只能靠没 @我的那条窄路去撞标准答案（要 0.85 以上），撞不上就一声不吭，
            # 话头断在这儿。**真人不会这样：自己问出去的话，对方答了就得接着办。**
            # 它只在机器人真问过他时成立（`asked_back` 里没有他 = 没这回事），
            # 所以不是「不 @ 就随便插话」，上一条的顾虑仍然成立。
            #
            # 不能把整段 @-检查往下挪：那样「人工接管中」那道闸（下面 handoffs.silenced）
            # 也会变成不@就触发，接管期间客户在群里随口聊两句就收一句「稍等」，是刷屏。
            # `/` 开头的照旧放过——理由跟下面 kb_admin.py 那句一样
            if not body.startswith("/") and wants_human(body):
                await handle_human(ev, body)
                return
            if body.startswith("/"):
                return
            # 第三条（2026-10-16）：**机器人刚答过他，他不 @ 我回了一句反馈**。
            # 真机：答完「connection dropped 是本地网络问题」，客户回「好了 真的是网络问题 感谢」，
            # 没 @ 我，机器人一声没吭 —— 真人客服这时候会回一句。
            # 「好了 / 感谢」→ 收个尾；「还是不行」→ 当成接着上一句说的，落进正式应答路往下查。
            # 判好评差评用的是夜间复盘那一套（review.feedback_kind），两边说法对得上
            fb = _feedback_on_answer(ev, body) if not answering else ""
            if fb == FB_GOOD:
                answered_at.pop((ev.group_id, ev.user_id), None)  # 同一次回答只收一次尾
                log.info("群 %s｜%s 答完说「%.20s」，收个尾", ev.group_id, ev.sender_name, body)
                await say(ev.group_id, random.choice(CLOSE_LINES), mention=ev.user_id, quote=int(ev.message_id or 0))
                return
            if fb == FB_BAD:
                answered_at.pop((ev.group_id, ev.user_id), None)
                log.info("群 %s｜%s 答完说「%.20s」，接着往下查", ev.group_id, ev.sender_name, body)
                answering = True  # 跟「答我反问」走同一条：带上一句、落进正式应答路
            if not answering:
                # 客户连着发好几条 → 并成一句再判（2026-10-16）。收尾、答反问都排在前面：
                # 那种当场该回，不等这几秒
                run = await collect_run(ev, body)
                if run is None:
                    return  # 这一堆有领队在收，交给它答
                body = run
                merged_done = True
                # 2026-10-15 起没 @ 我也答，但只答命中的（见 AUTO_MIN_CHARS 上面那段）。
                # 返回 True = 沾边、是在问客服（第三档）→ 当成 @ 我的问题往下走
                if not await auto_answer(ev, body):
                    return
                unasked = True
            # 一边答一边 @ 了别人：那是在跟别人说话，不接（跟 auto_answer 里同一条规矩）
            if any(s.get("type") == "at" and str((s.get("data") or {}).get("qq")) != str(ev.self_id) for s in ev.message):
                return
            question = body  # 落到下面那条正式的应答路上（退款、价格、发票、接管中那些闸照走）

        # 群里的管理指令归 kb_admin.py，这里放过，别把 `/答 12 …` 当成提问
        if question.startswith("/"):
            return

        # 自己人替客户问的（引用 / 原样复制），**从这里起 ev 换成那个客户**：回答 @ 他、
        # 会话开在他名下、冷却和追问也按他算（relay.py 第 1 条）
        asker, urls = await who_asked(ev, question)
        relayed = asker.relayed_by != 0
        if relayed:
            ev = replace(ev, user_id=asker.user_id, sender={"user_id": asker.user_id, "card": asker.nickname})
            question = asker.question

        # 想不开的话**排在所有闸的最前面**，包括红线和长度检查。
        # 2026-09-24 加的，起因见 bot/crisis.py 开头（真机 09-23 18:59）。
        # 为什么必须是第一道：
        # - 排在**长度检查**前面 —— 人难受的时候写得长，一条两百字里夹着那么一句，
        #   回他「问题有点长，挑最关键的一句问」是最糟的一种答法（跟转人工排在
        #   长度前面是同一条理由）；
        # - 排在**红线**前面 —— 一句「我吃了一把安眠药想自杀」同时命中涉毒词表，
        #   先撞红线的话客户收到的是「这个话题我就不聊了」。认错了的代价是多发一句
        #   关心的话，认漏了的代价不对称；
        # - 排在**人工接管中**前面 —— 接管中只回一句「稍等」。同事可能正好离开键盘，
        #   而这条不该等。红线本来也在接管前面，是同一个位置。
        crisis_word = crisis_hit(question)
        if crisis_word is not None:
            await handle_crisis(ev, question, crisis_word)
            return

        # 红线**排在长度检查前面**：一条 300 字的涉黄消息要是先撞上「问题有点长，
        # 挑最关键的一句问」，等于在请人家把那句话再发一遍
        bad_topic = topic(question)
        if bad_topic is not None:
            await handle_blocked(ev, question, bad_topic)
            return

        # 人工接管中：只回那句「稍等」。**排在红线后面、要人工前面**：
        # 接管中的客户再喊「人工」「退款」，人已经在了，不该再私聊叫一遍。
        # **只认「人工接管」**，等人工期间照常往下答（handoff.silenced 的注释）。
        # 这一步出任何错都当没被接管 —— 宁可多答一句，不可把客户哑掉
        # 自己人转述的不回「稍等」：人就是他，他点名要我答
        if not relayed and await handoffs.silenced(ev.group_id, ev.user_id):
            await handle_holding(ev, question)
            return

        # **要人工排在长度检查前面**，理由跟红线排在前面是同一条：人越急写得越长，
        # 一条两百字的火气话里写着「转人工」，回他「问题有点长，挑最关键的一句问」
        # 就是在最不该讲道理的时候讲道理。
        #
        # 注：`looks_like_refund` 现在**还在长度检查后面**，所以长退款消息有同样的问题。
        # 2026-09-23 管理员看过这个缺陷，选了「只动转人工，退款不碰」。别顺手一起挪。
        if wants_human(question):
            await handle_human(ev, question)
            return

        # 只 @我 发了张图（或者引用了一张截图），也算问题：下面看图
        # **答我反问的那一句不受这条管**：客户答「401」「Cherry Studio」就该接住，
        # 拿它去换一句「问题跟 @我 写在同一条发过来」是最不像人的一种答法
        if len(question) < MIN_QUESTION and not urls and not answering:
            # **只 @ 我、没带字 → 翻他自己刚说的话，当成同一个问题**（2026-10-16 大哥的实测要求）。
            #
            # 真机（LMUAI售前4 14:25）：客户先发「可用模型里为什么没有 Claude」，5 秒后单独 @ 我一下。
            # 机器人先回了他一句「问题跟 @我 写在同一条发过来就行」——**公开群里这是误伤**，
            # 客户刚刚才问完，却像被教怎么写问题；紧接着上一条又照标准答案答了一遍，等于回了两条。
            # 原来那句话是为「不 @ 就不答」那套闸写的（见 进度.md 第 21、26 条），
            # 现在没 @ 我照样答了（auto_answer），**这句话的前提没了**，整个去掉。
            back = await look_back(ev)
            if back is None:
                # 他@我了、上文又翻不着。不教书写格式，就一句最短的应声 —— 有人在
                await say(ev.group_id, "在的，你说~", mention=ev.user_id, quote=int(ev.message_id or 0))
                return
            prev_q, prev_id, prev_text = back
            # 上文那条**刚被「没 @ 我」那条路答过、或者正在答** → 别再回一条（真机那次就是这样：
            # 上一条已经在 14:25:11 发出去了，这条 @ 再答一遍就是重复）
            if prev_text and auto_asked.get((ev.group_id, ev.user_id)) == prev_text:
                log.info("群 %s｜%s 单独 @ 我，但上一条「%.28s」已经在答了，这条不重复",
                         ev.group_id, ev.sender_name, prev_text)
                return
            log.info("群 %s｜%s 单独 @ 我、没带字，翻上文当成同一个问题：%.30s", ev.group_id, ev.sender_name, prev_q)
            question = prev_q
            quote_id = prev_id or quote_id
        if len(question) > MAX_QUESTION:
            await say(
                ev.group_id, f"问题有点长（{len(question)} 字），挑最关键的一句问，我查得准一些。",
                mention=ev.user_id, quote=int(ev.message_id or 0),
            )
            return

        if looks_like_refund(question):
            await handle_refund(ev, question)
            return

        # 临时口径（/口径，09-30 加的）：生效期间跟它有关的问题，照他写的那句原话回。
        # **排在价格、发票闸前面**：口径是他亲笔写的，跟标准答案一个级别 —— 他发了「国庆充值送 10%」，
        # 客户问有没有优惠就该照这句回，不该再转人工。退款、要人工、红线、想不开都排在它前面，照旧
        if await from_notice(ev, question):
            return

        # 价格闸。**必须排在寒暄判别前面** —— 寒暄那条路是让模型自由发挥的，
        # 一句「你们贵不贵呀」要是先被当成闲聊，就等于把价格问题直接递给模型
        #
        # **它也排在冷却前面，这不是漏排。** 2026-09-23 管理员看过全部代价之后
        # 主动选的「保持」：词表里有「贵」「便宜」「优惠」这类口语词，连问三句就
        # 连着私聊三次，而且这比今天更吵（今天价格问题走业务路，是受冷却管的）。
        # 他要的是**宁可吵，不可漏** —— 排到冷却后面，一条 3 秒内到的价格问题会被
        # 静默丢掉：群里不回、超管不知道，跟「价格一律转人工」正好相反。
        # 真觉得吵，该做的是照 `notified` 的样子给私聊去重，**不是把这道闸往后挪。**
        if looks_like_price(question):
            await handle_price(ev, question)
            return

        # 发票跟价格并排，也在冷却前面，理由跟上面那段一样：排到冷却后面，
        # 一条 3 秒内到的发票问题会被静默丢掉，群里不回、他也不知道 ——
        # 那跟「只要提发票就叫人」正好相反
        inv_key = (ev.group_id, ev.user_id)
        if looks_like_invoice(question) or (
            time.monotonic() - invoice_asked.get(inv_key, -INVOICE_FOLLOW - 1) <= INVOICE_FOLLOW
            and invoice_follow_up(question)
        ):
            invoice_asked[inv_key] = time.monotonic()
            await handle_invoice(ev, question)
            return

        now = time.monotonic()
        prev = last.get(ev.user_id)
        if prev is not None and now - prev < settings.qa_cooldown:
            # 没 @ 我、被放进正式应答路的：冷却没到就**一声不吭**，连「一个一个来」都不说
            # （2026-10-26 管理员：他们俩在聊天，机器人就别插话）
            if unasked:
                log.info("群 %s｜%s 没 @ 我「%.30s」，冷却没到，不出声", ev.group_id, ev.sender_name, question)
                return
            # **不再一声不吭**（2026-10-16）：同一个人连着问两句，以前是静默跳过，
            # 他看到的就是「机器人不理我」。跟他说一句「一个一个来」就够
            log.info("%s 问得太快（间隔 %.1fs），这条跳过，跟他说一声", ev.sender_name, now - prev)
            await remind_one_at_a_time(ev)
            return
        last[ev.user_id] = now

        # 寒暄走另一路。**放在冷却之后**：它现在也要调一次模型，
        # 连点十下「你好」就是十次请求，冷却得管着它
        chat_kind = None if urls else smalltalk.kind(question)
        if chat_kind is not None:
            # 没 @ 我、被放进正式应答路的：判成寒暄也不出声。他是在跟别人聊天时
            # 顺口说了句「你好/谢谢」，机器人接一句就成了插话（2026-10-26）
            if unasked:
                log.info("群 %s｜%s 没 @ 我「%.30s」判成寒暄（%s），不出声",
                         ev.group_id, ev.sender_name, question, chat_kind)
                return
            await handle_smalltalk(ev, question, chat_kind)
            return

        # 客户连着发好几条 → 并成一句再答（2026-10-16）。**排在寒暄、转人工、退款、价格、发票后面**：
        # 那些要当场回，不受这几秒影响。@ 我的那条也照样并（客户常分两条打，@ 打在第一条上）
        if not merged_done:
            run = await collect_run(ev, question)
            if run is None:
                return
            question = run

        # 追问带上一句（relay.py 第 3 条），**以及客户在答我上一条反问**（第 4 条）。
        # **上面那几道闸只看这一句**，上一句不参与判价格、退款
        key = (ev.group_id, ev.user_id)
        prev_q = asked.get(key)
        context, skip = "", None
        # 答反问的那句不必像追问（不用短、不用带「那/呢」），窗口也放宽到 ASK_WINDOW
        follows = relay.looks_like_follow_up(question)
        window = relay.ASK_WINDOW if answering else relay.FOLLOW_WINDOW
        if prev_q and (answering or follows) and now - prev_q[1] <= window * 60:
            context, skip = prev_q[0], prev_q[2]
            log.info(
                "%s %s（%.30s）", ev.sender_name,
                "在答我上一条反问" if answering else "像是在追问上一句", context,
            )
            if answering:
                asked_back.pop(key, None)  # 只接一次：接完就清，免得下一条又被当成在答

        # 两层时限（2026-10-10 拆的，见 config.py 的 answer_timeout / answer_hard_timeout）：
        # - 软线 ANSWER_TIMEOUT：传给答题器，过了它不再开**额外**的模型调用（重问、换说法），手上的结果直接用
        # - 硬上限 ANSWER_HARD_TIMEOUT：到了才整个掐掉、按出错转人工
        # 以前只有一道 60 秒、而且是硬的：10-10 19:19 看图 11 秒 + 复核 7 秒否掉 #57，落回查资料只剩 40 秒，
        # claude 那一次没跑完就连人带答案一起掐了，客户收到「叫同事过来」。硬上限至少跟软线一样长（直接构造 Settings 时兜一下）
        hard = max(settings.answer_hard_timeout, settings.answer_timeout)
        # 看到哪一步了。硬上限掐掉时记进日志和私聊，下次不用再拿时间戳去猜卡在哪
        stage = "看截图"
        screens: list[str] = []

        async def work() -> Reply:
            nonlocal stage, screens
            # 看截图也算在时限里：看一张图要 5~40 秒（10-10 前的日志）
            screens, failed_images = await screens_of(ev, asker, urls, question)
            # 「最近对话」在答题之前拼好（2026-10-23）：模型得看见客户前面贴过什么、
            # 自己上一条回了什么。它内部任何异常都返回空，不影响这次回答
            thread, thread_staff, has_file = await thread_of(ev, asker, question)
            media = relay.media_note(failed_images, has_file)
            stage = "答题"
            # 别拆成多行：tests/test_qa.py 按「answerer.answer(question,」这段原文核对各道闸的先后
            soft = t0 + settings.answer_timeout
            return await answerer.answer(question, context=context, screens=screens, skip_entry=skip, deadline=soft, thread=thread, thread_staff=thread_staff, media_note=media)

        # 一个一个来（2026-10-16 管理员：「客户都是群里的…回复不过来需要先和客户说一下一个一个来」）：
        # **同一个群里同时只答一条**，谁先问谁先答。不串行的话，两个人的问题会并行地算、
        # 答案交叉着往外蹦 —— 群里看着就是「回复不过来」，还容易让人认错哪句是答自己的。
        # 等的时候先说一声（他看不见我在忙）；**排队等的时间不算在后面那 60 秒里**：
        # t0 在拿到锁之后才取 —— 排了两分钟再被掐成「叫同事过来」是最冤的一种失败。
        # 别的路（转人工、价格、发票、寒暄、没 @ 我的自动回复）都是秒回，不走这道排队
        lock = _group_lock(ev.group_id)
        if lock.locked():
            # 没 @ 我、被放进正式应答路的：要排队就**不排了，也不说「稍等」**。
            # 群里已经有一条在答，这条本来就不是点名叫我们的，等下去只会答到别人话茬里
            if unasked:
                log.info("群 %s｜%s 没 @ 我「%.30s」，前面还在答、要排队，不出声",
                         ev.group_id, ev.sender_name, question)
                return
            await remind_one_at_a_time(ev)
        got_turn = await _take_turn(lock)
        try:
            t0 = time.monotonic()
            try:
                async with asyncio.timeout(hard):
                    reply = await work()
            except TimeoutError:
                log.warning("%.0f 秒（硬上限）没答完，卡在%s，按出错处理：%.40s", hard, stage, question)
                reply = Reply(body=ERROR_TEXT, source=SRC_ERROR, elapsed_ms=int((time.monotonic() - t0) * 1000))
                timed_out = stage
            else:
                timed_out = ""
        finally:
            if got_turn:
                lock.release()
        if question:
            asked[key] = (question, time.monotonic(), reply.entry_id)
        if reply.source in (SRC_KB, SRC_RAG):
            # 真答了才记：转人工 / 答不上来那几句之后客户说「好的」，不该再回一句「解决了就好」
            answered_at[key] = time.monotonic()
            tip = endpoint_hint([question, *screens], reply.body)
            if tip:
                log.info("群 %s｜%s 请求的是 api.lmuai.ai，回复末尾补一句建议填 .com", ev.group_id, ev.sender_name)
                reply.body = reply.body.rstrip() + "\n\n" + tip
        # 流水、私聊里记的问法：追问写成「上一句 → 这一句」，截图单独记一笔（见下面 store.log）
        question = ask_label(question, context)
        shot_note = ("\n[看了截图：" + " / ".join(" ".join(x.split())[:60] for x in screens) + "]") if screens else ""
        if relayed:
            shot_note += f"\n[{asker.relayed_by} 转述的]"
        # **只有真答案分段发**（2026-09-24 管理员要的「一段一段发」）。
        # 标准答案按空行切、模型写的按句末标点切，理由见 `split_reply`。
        # 答不上来那句（SRC_MISS）是固定话术，一句话，不切。
        # 没 @ 我、被 auto_answer 放进正式应答路的：答不上来 / 出错时**一个字都不发**，
        # 也不开会话、不私聊超管（2026-10-26 管理员：他们俩在聊天，机器人就别插话）。
        # 照常记 qa_log，answer 末尾标一笔，复盘看得到这条为什么没出声。
        # **先算它、再判「别的客户接话了没有」**：这条即使后面有人接话，流水也要留下
        silent_fail = unasked and reply.source in (SRC_MISS, SRC_ERROR)
        # **发之前回头看一眼**：没 @ 我、也不是在答我反问的那种 —— 要是这条之后别的客户
        # 已经接话了（客户之间在聊），这条就别发了（2026-10-16 真机 19:10：查资料花了 10 秒，
        # 发出去的时候人家早聊过去了）。@ 我的、打 /问 的、答我反问的都不受这条管
        if (
            not silent_fail
            and not ev.at_me
            and not answering
            and not body.startswith(prefix)
            and await peers_cut_in(ev, int(ev.message_id or 0))
        ):
            log.info("群 %s｜%s「%.30s」查完发现别的客户已经接话了 → 这条不发了", ev.group_id, ev.sender_name, question)
            return
        if silent_fail:
            log.info(
                "群 %s｜%s 没 @ 我「%.30s」答成 %s，不出声（不发话术、不开会话、不私聊）",
                ev.group_id, ev.sender_name, question, reply.source,
            )
        else:
            await say(
                ev.group_id, with_hours(reply.text) if reply.source in (SRC_MISS, SRC_ERROR) else reply.text,
                mention=ev.user_id, chunk=reply.source in (SRC_KB, SRC_RAG), by_para=reply.source == SRC_KB,
                # 引用客户那条问句（2026-10-16 管理员：「回复需要引用对应的对话问题」）。
                # 群里同时在聊好几件事，不引用客户不知道答的是哪句
                quote=quote_id,
            )
            if reply.source == SRC_KB and reply.entry_id is not None:
                await send_entry_images(ev.group_id, reply.entry_id)

            # 机器人这句末尾是在向客户要信息（「你用的哪个客户端？」）→ 记一笔，
            # 他那句**不用 @ 我**也接（relay.py 第 4 条）。是别的话就把这一笔清掉：
            # 上一次问的要他答、这一次不问了，留着会让下一句无关的话被当成在答
            if relay.asks_back(reply.text):
                asked_back[key] = time.monotonic()
                log.info("群 %s｜%s 这句末尾在反问，%g 分钟内他那句不 @ 我也接", ev.group_id, ev.sender_name, relay.ASK_WINDOW)
            else:
                asked_back.pop(key, None)

        if reply.source == SRC_MISS and not silent_fail:
            # 开会话**必须在 notified 去重外面**，去重只管私聊响不响。放进去的话，
            # 第二个问同类问题的客户既没私聊、又没会话，/会话 和日报里都看不见他 ——
            # 分开之后最坏也只是「私聊没响，但名单上有」，还救得回来
            row = await handoffs.open(ev, question, R_MISS)
            if reply.cluster_id not in notified:
                # 答不上来也算「要你接手」，按分界走私聊（见 进度.md 第三节那张表）
                notified.add(reply.cluster_id or 0)
                why = (
                    f"模型答了，但里面有资料里查不到的 {'、'.join(reply.blocked[:3])}，没敢发\n"
                    if reply.blocked else ""
                )
                await notify_admins(
                    f"📨 这个问题答不上来\n群：{ev.group_id}\n客户：{ev.sender_name}（{ev.user_id}）\n"
                    f"原话：{question}{shot_note}\n{why}\n"
                    + (f"要定答案发：/答 {reply.cluster_id} 你的答案" if reply.cluster_id else "有标准答案了就发 /加 一句大白话")
                    + tag(row)
                )

        if reply.source == SRC_ERROR and not silent_fail:
            # 群里那句 ERROR_TEXT 说了「已经叫同事过来」，这里得真叫。会话照开（跟答不上来一样在去重外面）
            row = await handoffs.open(ev, question, R_ERROR)
            if time.monotonic() - error_notified_at > ERROR_NOTIFY_EVERY:
                error_notified_at = time.monotonic()
                await notify_admins(
                    f"⚠️ 调模型出错，客户已经收到「叫同事过来」那句\n群：{ev.group_id}\n"
                    f"客户：{ev.sender_name}（{ev.user_id}）\n原话：{question}{shot_note}\n"
                    + (
                        f"{hard:.0f} 秒没答完（硬上限），卡在{timed_out}。多半是模型这一次太慢，详情看 logs/bot.log。\n"
                        if timed_out else
                        f"耗时 {reply.elapsed_ms / 1000:.0f} 秒。多半是中转站报错，详情看 logs/bot.log。\n"
                    )
                    + f"{ERROR_NOTIFY_EVERY // 60} 分钟内再出错不重复私聊，都在 /会话 里"
                    + tag(row)
                )

        await asyncio.to_thread(
            store.log,
            group_id=ev.group_id, user_id=ev.user_id, nickname=ev.sender_name,
            # 被硬事实闸拦下的，answer 里记一笔拦了什么，日报和复盘看得到
            question=question,
            # 依据也是给复盘看的（2026-10-23），追加方式跟 [拦下：…] 一样；客户看不到
            answer=reply.text
            + (f"\n[拦下：资料里没有 {'、'.join(reply.blocked)}]" if reply.blocked else "")
            + shot_note
            + (f"\n[依据：{reply.basis}]" if reply.source == SRC_RAG and reply.basis else "")
            + ("\n[没 @ 我，答不上来，没出声]" if silent_fail else ""),
            source=reply.source, score=reply.score,
            entry_id=reply.entry_id, cluster_id=reply.cluster_id,
            rewritten=reply.rewritten, faithful=reply.faithful, elapsed_ms=reply.elapsed_ms,
            chunk_ids=reply.chunk_ids,
        )
        log.info(
            "群 %s｜%s 问「%.30s」→ %s（%.3f，%.1fs，依据 %s）",
            ev.group_id, ev.sender_name, question, reply.source, reply.score, reply.elapsed_ms / 1000,
            reply.basis or "-",
        )

    return answer_unasked
