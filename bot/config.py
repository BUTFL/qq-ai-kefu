"""配置加载。只认项目根目录的 .env（以及已存在的同名环境变量）。

密钥（令牌、API key）和行为开关都放 .env。规则类的结构化配置（自动审批规则等）
等阶段 3 真有规则了再引 toml，现在引是空转。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

_TRUE = {"1", "true", "yes", "on"}


class ConfigError(RuntimeError):
    """配置缺失或格式不对。启动时直接报错退出，不带着坏配置跑。"""


def _float(raw: str, key: str, default: float, *, lo: float, hi: float) -> float:
    raw = raw.strip()
    if not raw:
        return default
    try:
        val = float(raw)
    except ValueError:
        raise ConfigError(f"{key} 要填小数，现在是 {raw!r}") from None
    if not lo <= val <= hi:
        raise ConfigError(f"{key} 要在 {lo}~{hi} 之间，现在是 {val}")
    return val


def _int(raw: str, key: str, default: int, *, lo: int, hi: int) -> int:
    """照 `_float` 的结构写的整数版，用在「最多切几段」这类只能是整数的设置上。"""
    raw = raw.strip()
    if not raw:
        return default
    try:
        val = int(raw)
    except ValueError:
        raise ConfigError(f"{key} 要填整数，现在是 {raw!r}") from None
    if not lo <= val <= hi:
        raise ConfigError(f"{key} 要在 {lo}~{hi} 之间，现在是 {val}")
    return val


def _api_base(raw: str) -> str:
    """把 LLM_BASE_URL 补成 OpenAI 兼容的 `…/v1`，并去掉尾斜杠。

    **这是个实测踩过的坑。** 2026-09-22 试中转站：
    `POST {站点根}/chat/completions` 返回的是 **HTTP 200 + 一个 HTML 首页**，
    不是 404。也就是说漏了 `/v1` 不会报 401/404 这种一眼能认出来的错，
    而是每个问题都死在「回包不是 JSON」上，看日志根本想不到是地址少了两个字符。
    `{站点根}/v1/chat/completions` 才是对的。

    已经写了 `/v1`（或 `/v2`、`/api/v1`）的原样保留——只在末尾没有版本段时补。
    """
    url = raw.strip().rstrip("/")
    if not url:
        return ""
    tail = url.rsplit("/", 1)[-1].lower()
    if re.fullmatch(r"v\d+(?:beta\d*|alpha\d*)?", tail):
        return url
    return f"{url}/v1"


def _int_set(raw: str, key: str) -> frozenset[int]:
    """把 "1, 2,3" 这种英文逗号分隔的 QQ 号解析成集合；空串给空集。"""
    out = set()
    for piece in raw.split(","):
        piece = piece.strip()
        if not piece:
            continue
        if not piece.isdigit():
            raise ConfigError(f"{key} 里有不是数字的项: {piece!r}")
        out.add(int(piece))
    return frozenset(out)


@dataclass(frozen=True)
class Settings:
    onebot_url: str
    onebot_token: str
    # 机器人只在这些群里执行动作；空集 = 不限制。别的群的事件照收照记日志。
    enabled_groups: frozenset[int]
    super_admins: frozenset[int]
    # 「售后」群里自动放行所需的答案前缀。改它不用改代码
    approval_answer_prefix: str
    dry_run: bool
    log_level: str

    # ---- 掉线提醒 ----
    # 多久没心跳算掉线。NapCat 30 秒一拍，180 秒 = 连丢 6 拍才报；
    # 设短了一次网络抖动就能骗到它，每抖一次弹一条通知
    offline_alert_after: float = 180.0
    # 掉线时弹 macOS 通知。关掉就只剩日志和恢复后补发的那条私聊
    mac_notify: bool = True

    # ---- 阶段 5 AI 问答 ----
    # 下面每一项都带默认值，是为了 `Settings(...)` 在离线用例里只填核心几项就能构造
    # （`scripts/test_backfill.py` 就是这么用的，不读 .env）。
    # **加新字段记得跟着给默认值** —— 2026-09-22 这里漏过一次，
    # 补拉用例当场以 TypeError 挂掉，而且挂的样子和它要测的东西毫无关系，很费解
    llm_base_url: str = ""
    llm_api_key: str = ""
    # 对话和 embedding 分开走两个 key 时用这两个字段覆盖。
    # 不填就跟 llm_base_url / llm_api_key 一样（向后兼容，现有 .env 不用改）
    llm_chat_base_url: str = ""
    llm_chat_api_key: str = ""
    llm_chat_model: str = ""
    # **别用 deepseek-v4-flash**（原来的选型），它在这个中转站上会啃掉回复开头的几个字。
    # 实测见 bot/kb/llm.py 顶部。备选 glm-5.2，也干净，但误拒多一个、慢 0.7 秒
    llm_model: str = "kimi-k2.5"
    embedding_model: str = "qwen3.7-text-embedding"
    # 除了 @机器人，还认这个前缀触发问答
    qa_prefix: str = "/问"
    # 和标准答案的相似度到这个分才算「你已经定过这个问题」。
    # 定 0.78 的依据是方案 §10.4 的实测：「退款流程」vs「怎么把钱退回来」= 0.763，
    # 这两句没有共同词但确实是同一个问题，必须能命中，所以不能卡在 0.8 以上。
    kb_hit_score: float = 0.78
    # 到这个分以上就直接发，不再让模型复核「这条答案答不答他问的」（2026-09-30 加的，见 answer.py 的 _addresses）。
    # **为什么要复核**：命中线 0.78 拦不住「词面像、问的不是一回事」。09-30 真机：客户问
    # 「claude code 桌面端能和手机连接吗」，0.79 命中 #2「所在地区不可用，是先要挂梯子吗」——
    # 两句都在说桌面端，而答案里一个字没提手机。客户回「表示不懂」，23 分钟后管理员自己进群答的。
    # **为什么不是把 0.78 抬到 0.85**：那一截里同时有答对的（「开专票是多少个点」0.789、
    # 「怎么海外站全部不可用」0.784），抬线会连砍十来条。所以改成「低分的多花一次调用复核」。
    # 0.92 这个界是照线上 50 条命中标的：0.86 以上基本都对，撞错集中在 0.78~0.82；留到 0.92 是给余量。
    # 填 1.01 = 每条命中都复核（连原样命中也复核）；填 0 = 关掉复核，回到只看分数
    # ⚠️ 2026-10-14 起拿**向量分**跟它比，不再拿总分（向量 + 关键词）：关键词那路头名恒加 0.10，
    # 把向量 0.82~0.92 的都顶过了这条线、跳过复核，#2 因此连着三次答偏。见 answer.py 的 _addresses
    kb_sure_score: float = 0.92
    # 复核两级（2026-10-11 加的，见 answer.py 的 _addresses）：先让这个快模型判一遍，
    # 它判 NO 就直接按「没答」走、不再问对话模型；判 YES / 出错 / 超时 / 空回才交给对话模型（claude）终审，
    # 以终审为准 —— 「错答案发出去」那个方向始终由对话模型兜住。
    # **空串 = 关掉两级**，跟以前一模一样只问对话模型一次（默认关）。走 LLM_* 那组 key（flash 都在那组）。
    # 回放（scripts/replay_two_level_tmp.py，docs 开发文档 §37）：deepseek-v4.1-flash 当预筛，
    # 45 条该复核的省 20 次 claude、0 条错放行、3 条好答案被误杀（改去查资料）
    # 预筛最多等几秒，到了就当它没结论、交给对话模型。8 秒 = 回放里 deepseek-v4.1-flash 的 P90（6 秒）留点余量：
    # 超时这一下是**白等的**（等完还得问 claude），设大了慢的那几条反而比单级更慢
    # 资料片段低于这个分就认为「资料里没有」，回固定话术而不是硬编（方案 #39）。
    # **0.49 是量出来的，不是猜的。** 2026-09-22 拿 15 个「资料里确实有答案」和
    # 8 个「确实没有」的真实问法跑了一遍真库（926 块）：
    #   有答案：0.542（开专票）～ 0.865，最低的那个资料里明明写着「支持开具增值税发票」
    #   没答案：0.294 ～ 0.439（你们几点上班、能寄快递吗）
    # 两边中间空着 0.44～0.54 这一段，取 0.49 落在正中间。
    # 原来定的 0.55 高于「开专票」的 0.542，会把一个资料里有答案的问题判成答不上来。
    # 往下调不危险：过了这道门还有模型那道 NO_ANSWER 关（实测「怎么把余额提现」
    # 拿了 0.578 进门，模型照样认了资料里没有）
    rag_min_score: float = 0.49
    # 「沾边」线。分数掉在 RAG_WEAK ~ RAG_MIN 之间，资料仍然给模型，只是提示它
    # 「这次查到的只是沾边，语气放软」。**2026-09-23 管理员要的**：
    # 「不需要只要文档查不出来就开始问我……可以找相似的问题，你可以自己生成」。
    # 当天流水里 38 条 miss，「你知道啥」0.396、「为啥我问你的问题你都不知道」0.479
    # 这类全卡在 0.49 上，一条都没试过 —— 试一次的代价是一次模型调用，
    # 不试的代价是客户当面看见「我不知道」。
    # 低于这条线就真的别答了：资料完全不沾边时模型只能凭常识编。
    rag_weak_score: float = 0.33
    # 「相似问题」线。够不上 KB_HIT_SCORE（不敢直接发原文），但到了这个分，
    # 就把运营定过的那条问答**当资料塞给模型**参考。运营亲笔答案比文档片段可信，
    # 拿来当参照系比丢掉强。注意它永远不会被原样发出去 —— 那条路还是 kb_hit_score。
    kb_near_score: float = 0.55
    # 两句提问到这个分就算同一个问题，合并统计。比命中阈值严一点，
    # 否则日报里不同问题会被并成一类，统计就是假的
    cluster_score: float = 0.82
    # 命中标准答案后要不要让模型贴合当前问法重写。false = 原样秒发
    rewrite: bool = True
    # 长答案缩一版再发（answer.py 的 _condense，2026-10-16）。**跟重写分开**：
    # 重写管「贴合这次问法」，缩管「别长篇大论」，两件事各关各的。
    # 代价是每条超过 LONG_ANSWER 的答案多一次对话模型调用（库里 121 条里 55 条会触发）
    condense: bool = True
    # 答题的**软线**（秒，从收到问题、看截图算起）。过了它**不再开新的模型调用**（资料够却认了没有的重问、
    # 推责任换说法的重答），已经在跑的那一次照样等它答完，最多等到下面的硬上限。
    # 60 秒原来是**唯一**的时限，按 09-23~09-30 flash 线上最慢一条（46.6 秒）定的。10-09 对话换成
    # claude-opus-5-5 之后单次 7~45 秒（docs §35），复核一次 1~39 秒：10-10 19:19 那条
    # 看图 11 秒 + 复核 7 秒否掉标准答案 → 落回查资料时只剩 40 秒，那次调用没跑完就被整个掐掉，
    # 客户收到「叫同事过来」、开了会话 #86（docs §36）。所以拆成软线 + 硬上限两层
    answer_timeout: float = 60.0
    # 答题的**硬上限**（秒）。到了才当出错：回 ERROR_TEXT、开会话、私聊超管。
    # 120 = 软线 60 + 一次 claude 查资料最慢 45 秒再留余量；不填就取 max(120, 软线)
    answer_hard_timeout: float = 120.0
    # 同一个人问答的最小间隔秒数，防刷屏也防 QQ 风控（方案 #54）
    qa_cooldown: float = 3.0
    # 日报发哪个群。留空 = 不发。
    # 故意不默认取 ENABLED_GROUPS 的第一个：日报里有「答不上来 N 条」「命中率」
    # 这种内部数据，一旦默认值指到真实客户群就是当着客户面暴露机器人的短板
    report_group: int = 0
    # 问答日报的时间，HH:MM，24 小时制。**2026-09-29 起不定时发了**（有夜间复盘），
    # 留着这个配置是给 /日报 指令之外的老代码路径兜底，改它没有效果
    report_at: str = "22:00"

    # ---- 夜间复盘（bot/kb/review.py）----
    # 每天几点复盘。2026-09-28 管理员定的 23:00。复盘跑完直接把结果发到日报群，
    # 2026-09-29 起这就是每天唯一的一份（22:00 的问答日报停了，「等你定调」挪进了复盘）
    review_at: str = "23:00"
    # 关掉 = 不复盘、不记群消息，回到以前的样子
    review_enabled: bool = True
    # 盯广告（`bot/ads.py`）认定之后要不要自动撤回。**默认关 = 只私聊超管、不动群里的消息**：
    # 2026-09-30 他要的就是「先只报不撤，试运行几天」，看准了再 AD_RECALL=1 打开。
    # 撤回是删别人的话，删错了连原文都没了，所以默认不做
    ad_recall: bool = False
    # 一晚上最多调几次模型。**到了就停，没做完的明晚接着做**，不会因为哪天群里特别热闹
    # 就花一大笔。按现在的量（一天几十条）一晚上十几次就够
    # **0 = 不限**（2026-09-29 管理员：「不限制模型调用」，默认改成 0）。第一晚 60 次用完了「回答挑错」没做完
    review_max_calls: int = 0
    # 待审草稿攒到这么多条就不再起新的。你没审完，再起只会越堆越多（Zendesk 的做法）
    review_max_pending: int = 20
    # 夜间复盘用的对话模型，**跟白天答题的 LLM_MODEL 分开**（2026-09-29）。
    # 白天换成 deepseek-v4.1-flash 之后实测：复盘的长提示词（写三种说法、出 JSON）它会把 1500 甚至 4000 token
    # 全花在思考上、一个字正文都不出（finish=length、content 空）。kimi-k2.5 同一条 12 秒出完整 JSON，
    # glm-5.2 38 秒还被截断。复盘在半夜跑、不赶时间，要的是稳
    review_model: str = "kimi-k2.5"
    # 答案来源只认这些人在群里说的话（客户互相回答的只用来发现问题）。
    # 留空 = 只认 SUPER_ADMINS。以后加同事就在 .env 里写 TRUSTED=QQ号,QQ号
    trusted_extra: frozenset[int] = frozenset()

    # ---- 阶段 6 转人工会话 ----
    # 关掉 = 整套会话逻辑跳过，问答回到阶段 5 的样子（转人工照样回话术、照样私聊）
    handoff_enabled: bool = True
    # 人工接管期间客户每次 @我 都回这一句。2026-09-23 管理员定的原文，**一个字都别改**
    handoff_text: str = "稍等一下哦 他正在帮人解决问题，解决完第一时间回复你哦"
    # 「要人工」闸群里那句话术的降噪：同一个人同一个群这么多秒内只回一次
    # （2026-09-24 管理员要的，起因是不 @ 也能喊人工之后门槛低了）。
    # **只压群里的话术**，私聊通知和会话状态不受影响，理由见 qa.py handle_human
    handoff_reply_cooldown: float = 600.0

    # ---- 阶段 7 像真人：分段发送 + 推理 ----
    # 一条回复最多切成几段发。1 = 关掉分段，退回「整条一次发」的老行为。
    # **上限 3 是风控给的，不是排版给的**：QQ 号三秒内往一个群连发四五条是典型
    # 刷屏特征，这个号在五个真客户群里，被限制发言等于五个群同时哑掉
    reply_segments: int = 3
    # 段与段之间随机停多少秒。不用 CyberWaifu 那个固定 0.5——太快了还是机器节奏，
    # 而且连发间隔越短越像刷屏
    reply_gap_min: float = 1.2
    reply_gap_max: float = 2.0
    # 整条回复不超过这么多字就不切、一条发完（2026-10-09：「看字的长度」）。0 = 不设门槛
    # 单条消息的字数上限。**超了发不出去**：2026-10-16 真机（NapCat sendMsg 超时 retcode=1200），
    # 176 字的整条标准答案发失败，同一内容拆成 89/51/34 三段发 3/3 全成 → 定 90
    reply_single_max: int = 90
    # 让对话模型进思考模式。**默认关着**：glm-5.2 在 KNOWN_CLEAN 里是按
    # 非推理配置验的，开了 thinking 就不再是那个验过的配置了，而推理模式
    # 正是 2026-09-22「回复开头被啃掉」的触发条件（见 bot/kb/llm.py 顶部）。
    # 要开之前先按那套实测跑一轮：同一个问题连打十几次，看有没有哪次开头少字
    llm_thinking: bool = False

    # ---- 知识库接口（bot/admin_web.py，页面在 6099 左边栏）----
    # 只绑 127.0.0.1，跟 NapCat WebUI 同一个理由：能改答案等于能替机器人对客户说话。
    # 不另设口令：请求带 6099 的登录凭证，转手问 NapCat 真假（bot/napcat_auth.py）
    admin_port: int = 8090
    # 监听地址。直接跑在宿主机上就是 127.0.0.1；跑在容器里得是 0.0.0.0，
    # 否则 compose 的端口映射转不进来 —— 那时「只给本机」由 compose 的 127.0.0.1:8090 映射来保证。
    # Host 头校验（admin_web.guard）照旧，不受这项影响
    admin_host: str = "127.0.0.1"
    # 上传图片当资料时用哪个模型看图。glm-5.2 不收图，见 kb/llm.py read_image
    vision_model: str = "qwen3.7-plus"
    # 客户截图的备用看图模型：VISION_MODEL 在 LLM_* 那组 key 下回「模型不存在」（404 model_not_found）时换它再看一次。
    # **只在「模型不存在」时换**，超时、5xx 不换（再看一次又是一轮等待，客户在等）。
    # 默认 qwen3.8-flash：10-10 `/models` 实测在 LLM_* 那组里，爬虫看图用的就是它（5~8 秒）。填空 = 不要备用
    vision_fallback_model: str = "qwen3.8-flash"
    # 爬常见问题时看截图用的（kb/crawl.py）：只判「有没有用、有没有别家的名字」+ 写一句说明，要的是快。
    # 2026-09-29 同两张 Cherry Studio 截图实测：qwen3.8-flash 5~8 秒，qwen3.7-plus 40~76 秒，kimi-k2.5 14~18 秒，
    # MiniMax-M3 3~10 秒但两张图上写着「硅基流动」都判成没有别家 —— 这一条判错就是把别家的图发给客户，所以不用它
    crawl_vision_model: str = "qwen3.8-flash"
    # 每晚复盘完备份到哪（bot/kb/backup.py，2026-09-30 加的）。容器里 docker-compose 设成 /app/backup，
    # 挂的是宿主机 ~/linmu-backup/qa；直接在 Mac 上跑就是这个目录本身
    backup_dir: str = str(Path.home() / "linmu-backup" / "qa")
    # 留几份（一晚一份）
    backup_keep: int = 14
    # 验登录凭证要问 NapCat；CORS 也只放行这个来源（页面从 6099 打开）
    webui_url: str = "http://127.0.0.1:6099"
    # 浏览器打开 6099 用的地址，只给 CORS 用。留空就跟 webui_url 一样。
    # 容器里机器人连 NapCat 走 http://napcat:6099，但浏览器还是从 127.0.0.1:6099 开页面，两者得分开
    webui_public_url: str = ""
    # 局域网里打开 6099 用的地址（这台 Mac 的局域网 IP / 主机名），逗号分隔。
    # 8090 的 Host 校验和 CORS 除了本机再认这几个（2026-09-29 开的局域网访问，见 scripts/lan_proxy.py）。
    # **只认列出来的**，不放开成「什么 Host 都行」：那样 DNS rebinding 就回来了
    lan_hosts: frozenset[str] = frozenset()

    # ---- 远程协助（bot/remote/，2026-10-16 加的）----
    # 关着的时候机器人完全不碰远程协助，一切照旧。要开必须同时填 token
    remote_enabled: bool = False
    # 用哪家：awesun（向日葵，能连客户的识别码，实测能用）/ todesk（备用）
    remote_provider: str = "awesun"
    # MCP 传输方式。**容器里必须走 http**：MCP 服务端是 macOS 二进制，跑不进容器，
    # 由 launchd 常驻在宿主机（deploy/com.lingmou.awesun-mcp.plist），容器连过去。
    # stdio 只在宿主机上直接跑脚本时用得上
    remote_transport: str = "http"
    # 向日葵 MCP 的 HTTP 入口。`host.docker.internal` 只在容器里能解析 ——
    # 宿主机上跑 scripts/ 时 mcp_client._localize 会自动换回 127.0.0.1
    awesun_mcp_url: str = "http://host.docker.internal:8912/mcp"
    # 向日葵客户端本地的 API（stdio 模式下要塞给子进程；换端口时才要动）
    awesun_api_url: str = "http://127.0.0.1:8908"
    awesun_api_token: str = ""
    # ToDesk 自带的 MCP（绑在 AI 审计/ToClaw 上，要先在客户端开）。**必须在客户端里手动开**
    todesk_mcp_url: str = "http://127.0.0.1:8899/mcp"
    todesk_mcp_token: str = ""
    # 默认档：view 只能看、assist 能连能点能敲（够配中转站用）、full 含执行命令
    # **别默认给 full**：能跑命令就等于能改客户电脑上任何东西
    remote_profile: str = "assist"
    # 一单最多操作几次 / 最多开多久，防失控
    remote_max_ops: int = 200
    remote_session_ttl: float = 60.0
    # 客户 @我 说这些话，机器人就私聊问他有没有向日葵（2026-10-16 大哥定的口子）。
    # **只认这几类**：客户自己说「远程/帮我看看」这一类才问，别拿普通问题去打扰他
    remote_triggers: tuple[str, ...] = (
        "远程", "向日葵", "远控", "todesk", "to desk", "teamviewer", "anydesk",
        "帮我看看", "帮我看下", "帮我弄", "帮我配", "帮我设置", "你帮我", "远程协助", "帮我看一下",
    )
    # 同一个人多少小时内只问一次「要不要远程」。别当复读机
    remote_ask_cooldown: float = 12.0
    # 等客户回话 / 等大哥点头，超过这么久就失效（小时）
    remote_wait_minutes: float = 120.0
    # 连上之后最多连多久，到点自动断（分钟）。**必须有**：连上了没人管就是客户电脑一直开着门
    remote_session_minutes: float = 30.0
    # ---- AI 操作员（bot/remote/assist.py，2026-10-16）----
    # **默认关**。打开之后：大哥 /连 编号 时，机器人会看着客户屏幕自己点、自己填。
    # 关着的话连上就只发截图给大哥，他自己动手（原来的行为）
    remote_auto_assist: bool = False
    # 一次自动操作最多几步 / 用哪个模型看图（空 = 跟 VISION_MODEL 一样）
    remote_auto_steps: int = 12
    remote_auto_model: str = ""
    # 没说具体任务时默认做的事
    remote_auto_task: str = "帮客户把 AI 接口的中转站地址（base_url / API 地址）配置好，让它能正常连上"
    # 演练：只记日志和进度，不真动客户的电脑（先在验证机上试提示词）
    remote_auto_dry_run: bool = False
    # AI 操作员的实时画面：后台多少秒拉一帧（bot/remote/live.py）。向日葵一帧 ~0.19s，
    # 0.25 ≈ 4 帧/秒。调大省远控带宽，调小也快不过一帧的往返
    remote_live_interval: float = 0.25
    # /连 之后等客户在自己电脑上点「同意」最多多少秒。第一次 dial 几乎都要等这一下，
    # 以前写死 25 秒，客户还没找到弹窗就报失败了
    remote_approve_wait: float = 90.0

    @property
    def trusted(self) -> frozenset[int]:
        """谁说的话能当答案来源：超管 + TRUSTED 里额外写的"""
        return self.super_admins | self.trusted_extra

    def group_enabled(self, group_id: int) -> bool:
        return not self.enabled_groups or group_id in self.enabled_groups

    @property
    def llm_ready(self) -> bool:
        """中转站配全了没有。没配就只是 AI 问答不注册，
        已经上线的入群审批照常跑——不能因为阶段 5 没配齐就让整个机器人起不来。"""
        return bool(self.llm_base_url and self.llm_api_key)

    # ---- 「哪一组算对话」只在这里算一次 ----
    # 10-09（0292891）拆出 LLM_CHAT_* 之后，这条规则在几个地方各算了一遍：
    # bot/kb/wiring.py 装配时算一遍，scripts/ask.py 拿真模型试答时另算一遍。
    # ask.py 那一遍漏了 llm_chat_model，用的是 llm_model（上一个模型的旧值）——
    # 后果不是「答案不好看」：文档第三十节明写「换模型时手动跑一遍破甲实测」，
    # 而照那种跑法跑的是**已经被换掉的那个模型**，测试全绿，结论是假的。
    # 收成一处，两边都从这里取（跟 kb/text.py 的 OUR_DOMAINS 同一个套路：只留一份）
    @property
    def chat_base_url(self) -> str:
        """对话走哪个地址。LLM_CHAT_BASE_URL 有配就用它，没配退回 LLM_BASE_URL"""
        return self.llm_chat_base_url or self.llm_base_url

    @property
    def chat_api_key(self) -> str:
        """对话用哪个 key。同上，没配就退回 LLM_API_KEY"""
        return self.llm_chat_api_key or self.llm_api_key

    @property
    def chat_model(self) -> str:
        """**真正跟客户说话的那个模型**。llm_model 现在只喂 embedding 了，
        要判「对话模型是不是坏模型」「这次实测打的是哪个模型」都得看这个"""
        return self.llm_chat_model or self.llm_model

    @classmethod
    def load(cls, env_file: Path = ROOT / ".env") -> "Settings":
        # override=False：真实环境变量优先于 .env，方便临时改一项跑
        load_dotenv(env_file, override=False)
        env = os.environ

        token = env.get("ONEBOT_TOKEN", "").strip()
        if not token:
            raise ConfigError(f"ONEBOT_TOKEN 为空，请在 {env_file} 里配置")

        level = env.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
        if level not in {"DEBUG", "INFO", "WARNING", "ERROR"}:
            raise ConfigError(f"LOG_LEVEL 只能是 DEBUG/INFO/WARNING/ERROR，现在是 {level!r}")

        def _hhmm(key: str, default: str) -> str:
            raw = env.get(key, default).strip() or default
            try:
                h, m = (int(x) for x in raw.split(":", 1))
                if not (0 <= h < 24 and 0 <= m < 60):
                    raise ValueError
            except ValueError:
                raise ConfigError(f"{key} 要填 HH:MM（24 小时制），现在是 {raw!r}") from None
            return f"{h:02d}:{m:02d}"

        report_at = _hhmm("REPORT_AT", "22:00")
        review_at = _hhmm("REVIEW_AT", "23:00")

        report_group = env.get("REPORT_GROUP", "").strip()
        if report_group and not report_group.isdigit():
            raise ConfigError(f"REPORT_GROUP 要填群号，现在是 {report_group!r}")

        base_url = _api_base(env.get("LLM_BASE_URL", ""))

        # 硬上限不填就跟着软线走（至少 120）：以前单配了 ANSWER_TIMEOUT=200 的，升级后不该因为硬上限默认 120 起不来
        answer_timeout = _float(env.get("ANSWER_TIMEOUT", ""), "ANSWER_TIMEOUT", 60.0, lo=10.0, hi=600.0)
        answer_hard_timeout = _float(
            env.get("ANSWER_HARD_TIMEOUT", ""), "ANSWER_HARD_TIMEOUT", max(120.0, answer_timeout), lo=10.0, hi=900.0
        )
        if answer_hard_timeout < answer_timeout:
            raise ConfigError(
                f"ANSWER_HARD_TIMEOUT（{answer_hard_timeout}）不能比 ANSWER_TIMEOUT（{answer_timeout}）小：软线过了还要等到硬上限"
            )

        return cls(
            # ONEBOT_URL 一般不用配，NapCat 就在本机 3001；留个口子是为了以后 NapCat 挪去别的机器
            onebot_url=env.get("ONEBOT_URL", "ws://127.0.0.1:3001").strip(),
            onebot_token=token,
            enabled_groups=_int_set(env.get("ENABLED_GROUPS", ""), "ENABLED_GROUPS"),
            super_admins=_int_set(env.get("SUPER_ADMINS", ""), "SUPER_ADMINS"),
            # 统一小写存，匹配时也小写——客户手打答案，不该因为大写被挡在门外
            approval_answer_prefix=env.get("APPROVAL_ANSWER_PREFIX", "sub2").strip().lower(),
            dry_run=env.get("DRY_RUN", "true").strip().lower() in _TRUE,
            log_level=level,
            # 这两项 .env 里没有也对：默认 180 秒 + 开通知。
            # 故意做成「不填就能用」，因为 .env 归你手动维护，我不改它
            offline_alert_after=_float(
                env.get("OFFLINE_ALERT_AFTER", ""), "OFFLINE_ALERT_AFTER", 180.0, lo=30.0, hi=3600.0
            ),
            mac_notify=env.get("MAC_NOTIFY", "true").strip().lower() in _TRUE,
            llm_base_url=base_url,
            llm_api_key=env.get("LLM_API_KEY", "").strip(),
            llm_model=env.get("LLM_MODEL", "kimi-k2.5").strip(),
            llm_chat_base_url=_api_base(env.get("LLM_CHAT_BASE_URL", "")),
            llm_chat_api_key=env.get("LLM_CHAT_API_KEY", "").strip(),
            llm_chat_model=env.get("LLM_CHAT_MODEL", "").strip(),
            embedding_model=env.get("EMBEDDING_MODEL", "qwen3.7-text-embedding").strip(),
            qa_prefix=env.get("QA_PREFIX", "/问").strip(),
            kb_hit_score=_float(env.get("KB_HIT_SCORE", ""), "KB_HIT_SCORE", 0.78, lo=0.5, hi=1.0),
            # hi=1.01 是故意的：填 1.01 表示「每条都复核」（分数最高就是 1.0，永远小于它）
            kb_sure_score=_float(env.get("KB_SURE_SCORE", ""), "KB_SURE_SCORE", 0.92, lo=0.0, hi=1.01),
            rag_min_score=_float(env.get("RAG_MIN_SCORE", ""), "RAG_MIN_SCORE", 0.49, lo=0.0, hi=1.0),
            rag_weak_score=_float(env.get("RAG_WEAK_SCORE", ""), "RAG_WEAK_SCORE", 0.33, lo=0.0, hi=1.0),
            kb_near_score=_float(env.get("KB_NEAR_SCORE", ""), "KB_NEAR_SCORE", 0.55, lo=0.0, hi=1.0),
            cluster_score=_float(env.get("CLUSTER_SCORE", ""), "CLUSTER_SCORE", 0.82, lo=0.5, hi=1.0),
            rewrite=env.get("KB_REWRITE", "true").strip().lower() in _TRUE,
            condense=env.get("KB_CONDENSE", "true").strip().lower() in _TRUE,
            answer_timeout=answer_timeout,
            answer_hard_timeout=answer_hard_timeout,
            qa_cooldown=_float(env.get("QA_COOLDOWN", ""), "QA_COOLDOWN", 3.0, lo=0.0, hi=600.0),
            report_group=int(report_group) if report_group else 0,
            report_at=report_at,
            review_at=review_at,
            review_enabled=env.get("REVIEW_ENABLED", "true").strip().lower() in _TRUE,
            ad_recall=env.get("AD_RECALL", "").strip().lower() in _TRUE,
            review_max_calls=_int(env.get("REVIEW_MAX_CALLS", ""), "REVIEW_MAX_CALLS", 0, lo=0, hi=100000),
            review_max_pending=_int(env.get("REVIEW_MAX_PENDING", ""), "REVIEW_MAX_PENDING", 20, lo=1, hi=500),
            review_model=env.get("REVIEW_MODEL", "").strip() or cls.review_model,
            trusted_extra=_int_set(env.get("TRUSTED", ""), "TRUSTED"),
            handoff_enabled=env.get("HANDOFF_ENABLED", "true").strip().lower() in _TRUE,
            # 填了空串就用默认那句：客户收到一条空消息比收到默认话术糟得多
            handoff_text=env.get("HANDOFF_TEXT", "").strip() or cls.handoff_text,
            handoff_reply_cooldown=_float(
                env.get("HANDOFF_REPLY_COOLDOWN", ""), "HANDOFF_REPLY_COOLDOWN", 600.0, lo=0.0, hi=86400.0
            ),
            reply_segments=_int(env.get("REPLY_SEGMENTS", ""), "REPLY_SEGMENTS", 3, lo=1, hi=5),
            reply_gap_min=_float(env.get("REPLY_GAP_MIN", ""), "REPLY_GAP_MIN", 1.2, lo=0.0, hi=30.0),
            reply_gap_max=_float(env.get("REPLY_GAP_MAX", ""), "REPLY_GAP_MAX", 2.0, lo=0.0, hi=30.0),
            reply_single_max=_int(env.get("REPLY_SINGLE_MAX", ""), "REPLY_SINGLE_MAX", 90, lo=0, hi=2000),
            llm_thinking=env.get("LLM_THINKING", "false").strip().lower() in _TRUE,
            admin_port=_int(env.get("ADMIN_PORT", ""), "ADMIN_PORT", 8090, lo=1024, hi=65535),
            admin_host=env.get("ADMIN_HOST", "").strip() or "127.0.0.1",
            vision_model=env.get("VISION_MODEL", "qwen3.7-plus").strip() or "qwen3.7-plus",
            # 不用 `or 默认值`：填空就是「不要备用」
            vision_fallback_model=env.get("VISION_FALLBACK_MODEL", cls.vision_fallback_model).strip(),
            crawl_vision_model=env.get("CRAWL_VISION_MODEL", "").strip() or cls.crawl_vision_model,
            backup_dir=env.get("BACKUP_DIR", "").strip() or cls.backup_dir,
            backup_keep=_int(env.get("BACKUP_KEEP", ""), "BACKUP_KEEP", 14, lo=1, hi=365),
            webui_url=env.get("WEBUI_URL", "").strip() or "http://127.0.0.1:6099",
            webui_public_url=env.get("WEBUI_PUBLIC_URL", "").strip(),
            lan_hosts=frozenset(h.strip().lower() for h in env.get("LAN_HOSTS", "").split(",") if h.strip()),
            remote_enabled=env.get("REMOTE_ENABLED", "false").strip().lower() in _TRUE,
            remote_provider=env.get("REMOTE_PROVIDER", "").strip() or cls.remote_provider,
            remote_transport=env.get("REMOTE_TRANSPORT", "").strip() or cls.remote_transport,
            awesun_mcp_url=env.get("AWESUN_MCP_URL", "").strip() or cls.awesun_mcp_url,
            awesun_api_url=env.get("AWESUN_API_URL", "").strip() or cls.awesun_api_url,
            awesun_api_token=env.get("AWESUN_API_TOKEN", "").strip(),
            todesk_mcp_url=env.get("TODESK_MCP_URL", "").strip() or cls.todesk_mcp_url,
            todesk_mcp_token=env.get("TODESK_MCP_TOKEN", "").strip(),
            remote_profile=env.get("REMOTE_PROFILE", "").strip() or cls.remote_profile,
            remote_max_ops=_int(env.get("REMOTE_MAX_OPS", ""), "REMOTE_MAX_OPS", 200, lo=1, hi=10000),
            remote_session_ttl=_float(
                env.get("REMOTE_SESSION_TTL", ""), "REMOTE_SESSION_TTL", 60.0, lo=0.0, hi=1440.0
            ),
            remote_triggers=tuple(
                t.strip() for t in env.get("REMOTE_TRIGGERS", "").split(",") if t.strip()
            ) or cls.remote_triggers,
            remote_ask_cooldown=_float(
                env.get("REMOTE_ASK_COOLDOWN", ""), "REMOTE_ASK_COOLDOWN", 12.0, lo=0.0, hi=720.0
            ),
            remote_wait_minutes=_float(
                env.get("REMOTE_WAIT_MINUTES", ""), "REMOTE_WAIT_MINUTES", 120.0, lo=1.0, hi=10080.0
            ),
            remote_session_minutes=_float(
                env.get("REMOTE_SESSION_MINUTES", ""), "REMOTE_SESSION_MINUTES", 30.0, lo=1.0, hi=1440.0
            ),
            remote_auto_assist=env.get("REMOTE_AUTO_ASSIST", "false").strip().lower() in _TRUE,
            remote_auto_steps=_int(env.get("REMOTE_AUTO_STEPS", ""), "REMOTE_AUTO_STEPS", 12, lo=1, hi=60),
            remote_auto_model=env.get("REMOTE_AUTO_MODEL", "").strip(),
            remote_auto_task=env.get("REMOTE_AUTO_TASK", "").strip() or cls.remote_auto_task,
            remote_auto_dry_run=env.get("REMOTE_AUTO_DRY_RUN", "false").strip().lower() in _TRUE,
            remote_approve_wait=_float(
                env.get("REMOTE_APPROVE_WAIT", ""), "REMOTE_APPROVE_WAIT", 90.0, lo=5.0, hi=600.0
            ),
            remote_live_interval=_float(
                env.get("REMOTE_LIVE_INTERVAL", ""), "REMOTE_LIVE_INTERVAL", 0.25, lo=0.05, hi=5.0
            ),
        )
