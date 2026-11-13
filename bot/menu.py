"""`/命令`：机器人能干的事和全部指令，一条消息看完。

2026-09-29 管理员要的「/命令 展示功能」。以前只有两份 `/帮助`，各长在各的文件里：
私聊 `/帮助` 归 `handlers/admin.py`，只有入群审批那三条；群里 `/帮助` 归 `handlers/kb_admin.py`，
只有标准答案那几条。**哪一份都看不到自动的那些**（转人工几道闸、看截图、夜间复盘、自动关会话）。

数字（几分钟、几点、前缀）直接读代码里的常量和配置，不抄死 —— 改了那边这里跟着变，
不会出现「菜单说 1 天、实际 5 分钟」。
"""
from __future__ import annotations

from .config import Settings
from .handlers.dm import COOLDOWN as DM_COOLDOWN
from .handlers.qa import ERROR_NOTIFY_EVERY
from .handlers.relay import FOLLOW_WINDOW, IMAGE_WINDOW
from .handoff import IDLE_MINUTES, WORK_FROM, WORK_TO
from .kb.review import BRIEF_ITEMS
from .kb.watch import UNANSWERED_MINUTES
from .rules import AFTERSALE_TAG, PRESALE_TAG


def render(settings: Settings) -> str:
    prefix = settings.qa_prefix or "/问"
    sub = settings.approval_answer_prefix or "sub2"
    handoff = "" if settings.handoff_enabled else "（现在关着：HANDOFF_ENABLED=false）"
    dry = "（现在是演练模式，规则放行的也先问你）" if settings.dry_run else ""
    return "\n".join([
        "灵眸助手 · 功能和指令",
        "",
        "【客户群里自动做的】",
        f"· @我 或 {prefix} 开头提问：先对标准答案，没有就查资料站回答；答不上来转人工、记进待办",
        f"· 答题过了 {settings.answer_timeout:.0f} 秒不再重问模型、手上有什么答什么；"
        f"调模型出错、{max(settings.answer_hard_timeout, settings.answer_timeout):.0f} 秒还没答完：转人工，私聊超管（{ERROR_NOTIFY_EVERY // 60} 分钟内只报一次）",
        "· 不用 @：说「人工 / 找客服」直接叫人",
        f"· 没 @ 我的问题：{UNANSWERED_MINUTES} 分钟没同事回、又对得上标准答案，引用他那条答（只发标准答案原文）；对不上私聊你",
        f"· 命中标准答案但不够像（低于 {settings.kb_sure_score}）：发之前先自己核一遍「这条答的是不是他问的」，不是就改去查资料",
        f"· 客户私聊机器人：回一句「到群里 @我 或 @客服」（同一个人 {DM_COOLDOWN // 3600} 小时回一次）",
        "· 退款：安抚 + 叫人，不承诺能退",
        "· 问价格、问发票：先看标准答案，没有就叫人；按量分组倍率只报公开、在用的",
        f"· 截图：@我 那条带图，或 {IMAGE_WINDOW} 分钟内刚发过图，会先看图再答",
        f"· 追问：同一个人 {FOLLOW_WINDOW} 分钟内接着问（「那…呢」），带上上一句一起查",
        "· 自己人引用客户的话 @我，或原样复制客户的话 @我：回答 @ 客户本人",
        "· 打招呼、道谢、问你是谁：回一句人话，不查资料",
        "· 黄赌毒政治：固定话术，不接话；说想不开的话：关心一句 + 马上叫人",
        "· 新人进群：@ 他发防诈骗提醒",
        f"· 入群申请：「{PRESALE_TAG}」群自动同意；「{AFTERSALE_TAG}」群答案 {sub} 开头自动同意；其余私聊超管{dry}",
        "",
        f"【转人工】{handoff}",
        "· 等人工期间照常答；被接管后客户 @我 只回「稍等」",
        "· 超管或自己人在客户群开口 = 接管（群里恰好一个人在等时；多个就私聊问你回的是谁）",
        f"· {IDLE_MINUTES} 分钟没动静自动关（不另外通知）；{WORK_FROM}:00-{WORK_TO}:00 以外转人工，话术补一句下班时间",
        "/会话            谁在等人工、谁正被接着",
        "/接管 5          会话#5 你来聊，机器人闭嘴",
        "/结束 5          会话#5 交还给 AI",
        "",
        "【标准答案】最常用的是 /加",
        "/加 一句大白话   我整理成标准答案或临时口径给你看，回「好」才生效（/定调 /添加 /记住 也行）",
        "/答 3 内容       给 3 号待办定答案（编号在每晚复盘里）",
        "/改 7 内容       改 7 号答案",
        "/删 7            删 7 号答案",
        "/忽略 3          3 号待办不用答",
        "/同步            按改过的 知识库.md 覆盖（每次改答案都会自动写进 知识库.md）",
        "⚠️ 三种编号别混：/答 用待办编号，/改 /删 用答案编号，/接管 /结束 用会话编号",
        "",
        "【临时口径】官方波动、临时活动这种资料里没有的",
        "/口径 内容 2h    2 小时内客户问到相关的，照这句原话回（不写时长就 2 小时）",
        "/口径            看现在的　/口径 撤  提前撤掉",
        "",
        f"【夜间复盘】每晚 {settings.review_at}，日报群只发最要你动手的 {BRIEF_ITEMS} 件（日报群里机器人主动发的只有这一条）",
        "· 看客户反馈、学同事在群里的答法、找答错的、起草待办、合并重复答案、模拟考一遍",
        "· 起的东西都只进待审，每条给几种说法挑；全部草稿在 6099「待审草稿」页",
        "/复盘详情        上一次复盘的全文",
        "/采纳 4 2        4 号用第 2 种说法（不写就第 1 种）",
        "/不要 4          4 号不要，同类不再起",
        "",
        "【入群审批】私聊发",
        "/ls              没处理的申请",
        "/y 7             放行 7 号",
        "/n 7 理由        拒绝 7 号，理由发给对方",
        "",
        "【其它】",
        "/帮助            短一点的指令清单",
        "· 6099 页面：标准答案、资料库、待审草稿、自己人、群公告（勾售前售后群、日报群发公告、传文件）",
        f"· 盯广告：有人打别家广告、拉人进群、留联系方式、刷屏，私聊超管{'（认定了自动撤回）' if settings.ad_recall else '（只报不撤，试运行）'}",
        "· 掉线、白天很久收不到消息：私聊超管",
        "· 每天早上自动抓模型广场、套餐价、分组倍率",
        f"· 每晚复盘完备份库和答案附图到 ~/linmu-backup/qa，留 {settings.backup_keep} 份（不通知）",
        "",
        "谁能用：超管哪儿都能用；自己人在日报群里全部能用；群主、群管理员只能看（/复盘详情 /命令）",
    ])
