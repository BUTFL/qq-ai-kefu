"""AI 操作员：看着客户的屏幕，一步步把中转站配好。

链条：`截图 → 视觉模型判断下一步 → 执行 → 再截一张看结果`，直到模型说完成、或者撞到护栏。

**这一层是「让模型去动客户的电脑」，所以护栏比功能重要**，四条硬规矩：

1. **只准用 assist 档的动作**（点击/输入/按键/滚动/等待）。`run_command` 这类
   「能改客户电脑上任何东西」的动作**不在这层的白名单里**，模型说要跑命令也一律拒。
2. **步数、时间双封顶**（`REMOTE_AUTO_STEPS` / 每步超时）。模型可以犯错，但不能无限犯。
3. **模型的话不算数，格式不对就停。** 要的是严格 JSON；给不出合法动作、或者说不清点哪儿，
   直接停手报给大哥 —— **猜着点客户的电脑比不点糟糕得多**。
4. **大哥随时能掐。** 他发 `/远程断 编号` 会关掉会话，这一层每步开始都查一次
   `session.ended`，看到就立刻停。

审计不是这一层写的：每个动作都走 `RemoteOperator`，那边已经逐条记了 `data/remote_audit.jsonl`。
这里额外记的是**模型的判断理由**（`why`），出事了才追得回来「它当时以为自己在干什么」。
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# 这层允许的动作。**加新动作之前先想清楚**：每一个都是「在客户的机器上动手」
ALLOWED_ACTIONS = frozenset({"click", "type", "press", "hotkey", "scroll", "wait", "done", "give_up"})

# 明确禁止的（出现在**模型的自然语言字段**里就拒，并且记一条，方便回头调提示词）。
# **别往里加 "command"/"cmd"**：`COMMAND` 是这台远控合法的修饰键名（⌘），
# 任务里只要提到「按 Command+空格」，模型就会照实回 keys=["command","space"] ——
# 2026-10-16 就是这么把一条正常任务拦成了「不合规」。
# 真要让模型别跑命令，靠的是动作白名单（runCommand 根本不在里面）+ 下面这几个词
# **别往里加 "terminal"/"shell"/"终端" 这类词**：客户要在 CLI 里用 Claude 时，
# 正当操作就是「打开终端窗口、用键盘打字」—— 模型在理由里写「打开终端」是正常的。
# 2026-10-16 就是因为表里有 "terminal"，把一次正当的 CLI 验收拦成了"不合规"。
# 真正防住"跑命令"的是**动作白名单**（runCommand 根本不在里面），不是这张词表。
FORBIDDEN_HINT = ("执行命令", "关机", "重启", "格式化", "删除文件", "rm -", "sudo")

# ---- 键名归一化（2026-10-16 实测）----
# 这台远控认的是**大写专名**：ESCAPE / RETURN / SPACE / ENTER / DELETE / TAB / 方向键 / A-Z / F1-F12 / HOME 等；
# 实测**不认**：`esc`（小写，得写 ESCAPE）、BACKSPACE、PAGEUP。
# 模型天生爱写 `esc`、`cmd`、`enter` 这些小写简称 —— 2026-10-16 真机就是这么把一步整挂的
# （它想按 Esc 关掉 Spotlight，工具直接报 key not supported，那一步失败、整条任务停住）。
# 所以在这一层统一翻译，**别指望模型每次都写对**。
KEY_ALIASES = {
    "esc": "ESCAPE", "escape": "ESCAPE",
    "enter": "RETURN", "ret": "RETURN", "return": "RETURN",
    "space": "SPACE", "spacebar": "SPACE",
    "cmd": "COMMAND", "command": "COMMAND", "meta": "COMMAND", "super": "COMMAND", "win": "WIN",
    "ctrl": "CONTROL", "control": "CONTROL",
    "alt": "ALT", "option": "ALT", "opt": "ALT", "menu": "MENU",
    "shift": "SHIFT", "tab": "TAB",
    "del": "DELETE", "delete": "DELETE", "backspace": "DELETE", "back": "BACK",
    "up": "UP", "down": "DOWN", "left": "LEFT", "right": "RIGHT",
    "home": "HOME", "end": "END",
}
# 提示词里告诉模型这些名字，省得它猜
KEYS_HELP = ("ESCAPE, RETURN, SPACE, TAB, DELETE, UP, DOWN, LEFT, RIGHT, HOME, END, F1-F12, 单个字母（如 A、V），"
             "修饰键 COMMAND / SHIFT / CONTROL / ALT")


# ---- 账号密码：**一律用户自己输入**（2026-10-16 大哥定的规矩）----
# 机器人/AI 操作员**绝不**去碰账号、密码、验证码、手机号这一类东西：
# 不输入、不代填、不读剪贴板里的密码。碰到登录页/验证码/二次验证，就停手交给用户自己输。
# **这条比"把活干完"重要** —— 客户把账号密码交给机器人，出了事谁都担不起。
CREDENTIAL_WHY_HINT = ("密码", "验证码", "手机号", "短信", "password", "passwd", "captcha", "verify code", "两步", "二次验证")


def looks_like_credential(text: str) -> bool:
    """这段文字像不像账号/密码/验证码（像就拒绝输入）。"""
    t = (text or "").strip()
    if not t:
        return False
    if re.fullmatch(r"[\w.+-]+@[\w-]+\.[\w.]+", t):        # 邮箱
        return True
    if re.fullmatch(r"\+?\d[\d\s-]{6,}", t):                # 手机号 / 一长串数字
        return True
    if re.fullmatch(r"\d{4,8}", t):                          # 验证码
        return True
    return False


# ---- 瘦身版提示词（2026-10-16，配合 deepseek-v4.1-flash）----
# 为什么有这一版：实测 qwen3.7-plus 一步要 6 秒、最慢 86 秒，其中 5348 个 token 全是"思考"；
# 换成明确的 JSON 指令后，deepseek-v4.1-flash 把思考压到 ~190 token，**一步 1.3~1.8 秒**，
# 而且点输入框那种目标照样准（实测误差 18 像素，跟 qwen 一个水平）。
# 注意：**只有 deepseek 系用这版**。qwen 在瘦身版下会点偏（实测偏 332 像素），
# 它需要上面那版啰嗦的提示词才准 —— 所以按模型挑。
SLIM_PROMPT = """你在通过远程控制软件操作客户自己的电脑。只做一件事：给出下一步的**那一个动作**。

任务：{task}
屏幕：{w} x {h} 像素（坐标换算成 0~1 的小数，左上角是 0,0）
已经做过的步骤：
{history}

**只输出一行 JSON，不要解释、不要 markdown、不要思考过程、不要换行：**
{{"action":"click","bbox":[左,上,右,下],"why":"不超过15字"}}

其它动作同样只给一行：
{{"action":"type","text":"要输的字","why":"…"}} / {{"action":"press","keys":["RETURN"]}} /
{{"action":"hotkey","keys":["COMMAND","A"]}} / {{"action":"scroll","bbox":[左,上,右,下],"direction":"down"}} /
{{"action":"wait"}} / {{"action":"done"}} / {{"action":"give_up"}}

优先给 bbox（我取它的中心点）。要打字先 click 输入框。拿不准就 give_up。
装没装：**已装就直接用、别再装**；确认没装就**按官方渠道装上**（CC Switch 从官方 GitHub releases 下 macOS 版、装完启动一次；Claude Code CLI 按官方说明装），装前先跟客户说一句。
按键名只认这些：{keys_help}
打字前先看输入法（是中文就先 CONTROL+SPACE 切英文 US）；开应用用 COMMAND+SPACE 搜名字，别点 Dock 图标猜。
禁止：关机 / 重启 / 删除文件 / 输入账号密码验证码；同一个动作别连着做第二遍。
步骤后面标着「画面没变化」= 那一下没生效，换个位置或换个做法。"""


def normalize_keys(keys: list[str]) -> list[str]:
    """把模型写的键名翻成这台远控认的写法：小写转大写、简称补全（`esc`→`ESCAPE`）。"""
    out: list[str] = []
    for k in keys or []:
        raw = str(k).strip()
        if not raw:
            continue
        out.append(KEY_ALIASES.get(raw.lower(), raw.upper() if len(raw) == 1 else raw.upper()))
    return out

DEFAULT_TASK = "帮客户把 AI 接口的中转站地址（base_url / API 地址）配置好，让它能正常连上"

PLAN_PROMPT = """你在通过远程控制软件操作【客户自己的电脑】，帮客服解决配置问题。

当前任务：{task}

屏幕分辨率：{w} x {h} 像素（你的坐标要按这个尺寸换算成 0~1 的小数）

已经做过的步骤：
{history}

请你看着这张屏幕截图，决定**下一步只做哪一个动作**。

【配中转站的默认打法】客户说「帮我配置一下」「我要在 CLI / Claude Code 里用 Claude」这类话，
就是让你**把灵眸中转站配到他的电脑上**。按这套走，不用再问细节：

0) 先看客户电脑**有没有装** CC Switch 和 Claude Code CLI：装了直接用；**确实没装就帮他装上**
   （见上面「装没装」那条），装完再往下配。
1) **线路一律用直连端点 `https://api.lmuai.com`**。导入时会弹「选择 API 线路」，选 `.com` 那一条
   （页面上叫「直连端点」），别选 `.ai` 那条。
2) 要新建密钥时：**分组选名字里带 Claude 的那一档**（比如 Claude-Pro / Claude-MAX）；
   CLI / Claude Code 走的是 Anthropic 协议，只有 Claude 档能用。
3) 建完点这一行「操作」列里的「导入到 CCS」→ 浏览器问「是否允许打开 CC Switch」→ 允许 →
   CC Switch 弹「确认导入供应商配置」→ 点「导入」。
4) 切到 CC Switch：鼠标悬停「灵眸」那一行 → 点右侧「启用」→ 看到「使用中」或「切换成功！」就算成。
5) **账号、密码、验证码一律让客户自己输**：碰到登录页就停下等他登录，登录完接着往下做。

规则（必须遵守）：
- 一次只做一个动作，做完会有新的截图给你看。
- **定位要两步走**：先在 `why` 里用文字说清目标在哪儿（拿画面里的东西当参照，例如
  「窗口标题栏最左边那个红点，横向大约在整幅图的三分之一处」），**再**给坐标。
  直接拍脑袋给一个点会偏 —— 2026-10-16 实测偏过 200 像素。
- 要往输入框里打字，**必须先 click 那个输入框**，下一次再 type。
- **打字前先看菜单栏的输入法**：如果是「拼 / 简体 / 五笔」这种中文输入法，先按 `CONTROL+SPACE` 切到
  英文（菜单栏变成 `US` 或 `A`）**再打字母** —— 否则字母会被输入法吞掉。
  2026-10-16 真机：名字框里出现 `aa`、`a1241552681@qq.com`、地址栏只剩一个 `G`，全是这个原因。
- **开应用别猜 Dock 图标的坐标**：用 `COMMAND+SPACE` 搜应用名 → `RETURN`。
  真机实测按 Dock 坐标点，开出过「系统偏好设置」「软件更新」，还反复空点 Chrome。
- **浏览器地址栏**：先 `COMMAND+A` 全选，再 type，然后按 `RETURN`。
  **别用 `COMMAND+RETURN`**（那是「在新标签页打开」，页面看着像没跳过去）；
  **别去点下拉建议**，直接回车。这几条都是 2026-10-16 真机踩出来的。
- **要切到某个 App，就用聚焦搜索**：`COMMAND+SPACE` → type 应用名（比如 `CC Switch`）→ `RETURN`。
  这条路真机上验过好几次好用。
  **别用 `COMMAND+TAB`**：2026-10-16 实测按十次窗口都不换（远控发的是瞬时按键，macOS 那个切换器不认）。
  **也别靠 Dock 图标的形状猜**：真机把 Clash Party 当成 CC Switch，在它的菜单里翻了半天找配置。
  切错了窗口就在聚焦搜索里重新搜一次应用名。
- 按键名就用这些写法（这台远控只认大写专名）：{keys_help}。
  要关掉 Spotlight 那种浮层，**再按一次 Command+空格** 就行 —— 别写 esc（要写就写 ESCAPE）。
- **同一个动作别连着做第二遍**：上面「已经做过的步骤」里如果刚做过同样的 click 而屏幕没变化，
  说明那一下没生效 —— 换个做法（直接 type、或按 RETURN、或换个位置），别再点同一个地方。
  2026-10-16 真机对着 Spotlight 输入框连点三次，就是这条缺失造成的。
  你看到的是**实时画面**：步骤后面标着「（之后画面没变化）」就是那一下确实没生效。
- **在终端窗口里用键盘打字是允许的**（客户说"我要在 CLI 里用 Claude"时就得这么验）；
  但**不允许**走「执行命令」这类动作 —— 那不在你的动作白名单里，提了会被拒。
- **账号、密码、验证码一律让用户自己输入**：你**绝不**输入邮箱、密码、验证码、手机号，也不代填、不去读剪贴板。
  看到登录页、验证码、二次验证，就 give_up 并在理由里写「需要您自己输入账号」。
  这条比把活干完重要 —— 2026-10-16 大哥定的规矩。
- 不确定该点哪儿就 give_up，**不要猜**。点错客户的电脑比不点糟糕得多。
- **判断某个软件装没装，要确认两遍再下结论**：先看「应用程序」文件夹，再用聚焦搜索搜一次
  （换个叫法搜，比如「CC Switch」和「CCSwitch」）。**只扫一眼搜索结果就认定"没装"是踩过的坑**：
  2026-10-16 真机把已经装好的 CC Switch 当成没装，差点让它去下载。
- **装没装，分两种情况处理**（2026-10-16 大哥定的）：
  · **已经装了** → 直接用，**不要**再下载/安装（重复安装是踩过的坑）。
  · **确认确实没装**（两遍都没找到）→ **就帮客户装上** —— 这是服务的一部分：
    先从对话框里跟客户说一句"这台电脑没装 XXX，我帮你装上"，然后走**官方渠道**一步步装：
    CC Switch → 官方仓库 `https://github.com/farion1231/cc-switch/releases` 下 macOS 版，
    装完**至少启动一次**（要让系统登记 `ccswitch://` 协议，否则「导入到 CCS」唤不起来）；
    Claude Code CLI → 按官方安装说明装（客户要在 CLI 里用 Claude 就得有它）。
    装的过程中每一步都先看截图确认，别连点。
- 拿不准"到底装没装"就 give_up 问一句 —— 别瞎装，也别漏装。
- **绝对不要**点关机、重启、删除、格式化这类东西；也不要打开终端敲命令。
- 如果任务已经完成（比如地址已经填好并保存了），回 done。

只输出一个 JSON 对象，不要任何别的文字、不要 markdown 代码块：
{{"action": "click|type|press|hotkey|scroll|wait|done|give_up",
  "bbox": [0.30, 0.20, 0.36, 0.26],
  "text": "要输入的文字（type 时用）",
  "keys": ["control", "v"],
  "direction": "down",
  "why": "先说清目标在哪儿（拿画面里的东西当参照），再说为什么"}}

**优先给 `bbox`**（目标那一小块的范围，[左, 上, 右, 下]，都是 0~1 的小数，按整幅图算），
我取它的中心去点 —— 比直接给一个点准。实在给不出范围才用 "x"/"y"。

字段说明：click 要 x/y；type 要 text（x/y 可选，表示先点那儿再输）；press 要 keys（单键，如 ["return"]）；
hotkey 要 keys（组合键，如 ["control","v"]）；scroll 要 x/y 和 direction；wait 不用参数；done/give_up 只要 why。
坐标是 0~1 的小数，从屏幕左上角算起。"""


@dataclass
class Decision:
    action: str
    x: float = 0.0
    y: float = 0.0
    text: str = ""
    keys: list[str] = field(default_factory=list)
    direction: str = "down"
    why: str = ""
    bbox: list[float] = field(default_factory=list)

    @property
    def summarized(self) -> str:
        bits = [self.action]
        if self.action in ("click", "scroll"):
            where = f"({self.x:.2f},{self.y:.2f})"
            if self.bbox:
                where += f" bbox={[round(v, 2) for v in self.bbox]}"
            bits.append(where)
        if self.text:
            bits.append(f"输入「{self.text[:30]}」")
        if self.keys:
            bits.append("+".join(self.keys))
        return " ".join(bits) + (f" —— {self.why}" if self.why else "")


# parse_decision 是纯函数，拒绝原因用它带出来（每步开始前重置）
self_refused: dict[str, str] = {}


def parse_decision(raw: str) -> Decision | None:
    """把模型的回包抠成 Decision。抠不出来返回 None（**不许猜**）。"""
    txt = (raw or "").strip()
    m = re.search(r"\{.*\}", txt, re.S)      # 有的模型爱在 JSON 外面套一段话或代码块
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    action = str(data.get("action") or "").strip().lower()
    if action not in ALLOWED_ACTIONS:
        return None
    # **bbox 优先**：模型给范围比给点准。给了就取中心当点击坐标
    x, y = data.get("x", 0), data.get("y", 0)
    bbox: list[float] = []
    raw_box = data.get("bbox")
    if isinstance(raw_box, (list, tuple)) and len(raw_box) == 4:
        try:
            bbox = [float(v) for v in raw_box]
        except (TypeError, ValueError):
            bbox = []
        if bbox and all(0.0 <= v <= 1.0 for v in bbox) and bbox[2] >= bbox[0] and bbox[3] >= bbox[1]:
            x, y = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        else:
            bbox = []          # 框不合法就当没给，退回 x/y
    try:
        d = Decision(
            action=action,
            x=float(x or 0),
            y=float(y or 0),
            bbox=bbox,
            text=str(data.get("text") or ""),
            keys=[str(k) for k in (data.get("keys") or [])],
            direction=str(data.get("direction") or "down").lower(),
            why=str(data.get("why") or "")[:200],
        )
    except (TypeError, ValueError):
        return None
    # 坐标必须在 0~1，越界当模型算错了 —— 宁可停也不点错地方
    if d.action in ("click", "scroll") and not (0.0 <= d.x <= 1.0 and 0.0 <= d.y <= 1.0):
        return None
    if d.action == "type" and not d.text:
        return None
    if d.action in ("press", "hotkey"):
        if not d.keys:
            return None
        d.keys = normalize_keys(d.keys)      # `esc`→ESCAPE 这种翻译在这一层做掉
    if d.direction not in ("up", "down"):
        d.direction = "down"
    return d


def shot_bytes(shot: dict[str, Any]) -> bytes:
    """从截图回包里取图片字节。

    **两种都要处理**：向日葵同时给 `image_path`（宿主机文件路径）和 `image_base64`。
    机器人跑在容器里时 `image_path` 那个路径是不存在的（宿主机上的路径），
    只有 base64 能用 —— 2026-10-16 上线时实测过。
    """
    p = str(shot.get("image_path") or "")
    if p and Path(p).exists():
        try:
            return Path(p).read_bytes()
        except OSError as e:
            log.warning("截图文件读不出来（改用 base64）：%s", e)
    b64 = str(shot.get("image_base64") or "")
    if b64:
        try:
            return base64.b64decode(b64)
        except (ValueError, TypeError):
            return b""
    return b""


class AutoAssist:
    """一次自动操作。跑完返回一句人话总结（给大哥看）。"""

    def __init__(
        self,
        operator: Any,          # RemoteOperator
        session: Any,           # operator.Session
        llm: Any,               # bot.kb.llm.LLM（只要有 read_image）
        *,
        model: str,
        fallback_model: str = "",
        task: str = "",
        max_steps: int = 12,
        step_timeout: float = 60.0,
        dry_run: bool = False,
        on_step: Any = None,    # 每步回调（异步），给大哥报进度用
        screen: Any = None,     # live.LiveScreen：给了就看实时画面，不再每步单独截图
    ) -> None:
        self.op = operator
        self.session = session
        self.llm = llm
        self.model = model
        self.fallback_model = fallback_model
        self._used_fallback = False
        self.task = task or DEFAULT_TASK
        self.max_steps = max_steps
        self.step_timeout = step_timeout
        self.dry_run = dry_run
        self.on_step = on_step
        self.screen = screen
        self._frame: Any = None     # 这一步模型看的是哪一帧（动作做完拿它比「变没变」）
        self.rethinks = 0           # 因为「想的时候画面变了」重想了几次
        # 这一轮怎么收的场：done / give_up / credential / refused / error / limit / ended / dry_run。
        # flow 靠它决定「做完了就自动断开、告诉客户」，**只有 done 才算做完**
        self.outcome = ""
        self.history: list[str] = []

    async def run(self) -> str:
        """主循环。返回一句给大哥看的总结（失败也说清楚失败在哪）；收场方式记在 `self.outcome`。"""
        self.outcome = "error"      # 中途抛出去也算出错，别留空让调用方误判
        for step in range(1, self.max_steps + 1):
            if getattr(self.session, "ended", False):
                self.outcome = "ended"
                return f"已停止：会话被关掉了（做了 {step - 1} 步）"
            self_refused.pop("why", None)      # 每步开始清一次：拒绝原因只对当步有效
            try:
                decision = await self._think()
                if self._stale(decision):
                    # 模型想的那 1~2 秒里画面**明显**变了（弹窗、页面跳转）：它给的坐标是按旧画面算的，
                    # 照着点就是点错地方。看新画面重想一次；每步只重想一次，免得画面一直动就卡死
                    self.rethinks += 1
                    log.info("AI 操作员：想的时候画面变了，按新画面重想第 %s 步", step)
                    self_refused.pop("why", None)
                    decision = await self._think()
            except Exception as e:
                log.warning("AI 操作员：判断这一步时出错，停手：%s", e)
                self.outcome = "error"
                return f"停在第 {step} 步：判断屏幕时出错（{type(e).__name__}: {str(e)[:80]}），没继续动他的电脑"
            if decision is None:
                if self_refused.get("why") == "credential":
                    self.outcome = "credential"
                    return (f"停在第 {step} 步：这一步要输账号/密码/验证码 —— "
                            f"这类东西**一律由你自己输入**，我不碰（规矩）。登录完叫我，我接着配。")
                self.outcome = "refused"
                return f"停在第 {step} 步：模型给的动作不合规或说不清点哪儿，没继续动他的电脑"
            if decision.action == "give_up":
                self.outcome = "give_up"
                return f"模型说做不了：{decision.why or '（没说原因）'}（做了 {step - 1} 步）"
            if decision.action == "done":
                self.outcome = "dry_run" if self.dry_run else "done"
                return f"完成 ✅（{step - 1} 步）：{decision.why or self.task}"
            try:
                after = await self._act(decision)
            except Exception as e:
                log.warning("AI 操作员：执行 %s 失败：%s", decision.action, e)
                self.outcome = "error"
                return f"停在第 {step} 步：执行「{decision.summarized}」失败（{str(e)[:80]}）"
            self.history.append(f"{step}. {decision.summarized}{after}")
            if self.on_step is not None:
                try:
                    await self.on_step(step, decision.summarized)
                except Exception as e:      # 报进度失败不能拖垮操作
                    log.debug("AI 操作员报进度失败：%s", e)
            if self.dry_run:
                self.outcome = "dry_run"
                return f"演练到此（{step} 步），没有真动他的电脑。最后想做的是：{decision.summarized}"
        self.outcome = "limit"
        return f"到步数上限（{self.max_steps} 步）停下了，最后一步是：{self.history[-1] if self.history else '无'}"

    def _stale(self, d: Decision | None) -> bool:
        """这个决定是不是按过时的画面做的。只管**要点位置**的动作，且只认「明显变了」。"""
        if d is None or self.screen is None or self.dry_run:
            return False
        if d.action not in ("click", "scroll") and not (d.action == "type" and (d.x or d.y)):
            return False
        return self.screen.compare(self._frame, self.screen.latest()) is True

    async def _look(self) -> tuple[bytes, Any, Any]:
        """当下的画面：有实时画面就取最新一帧，没有才单独截一张（老路子，脚本/用例还在用）。"""
        if self.screen is not None:
            f = await self.screen.fresh()
            self._frame = f
            return f.data, f.width, f.height
        shot = await self.op.screenshot(self.session)
        return shot_bytes(shot), shot.get("image_width"), shot.get("image_height")

    async def _think(self) -> Decision | None:
        data, w, h = await self._look()
        if not data:
            raise RuntimeError("截图没取到")
        hist = "\n".join(self.history) if self.history else "（还没动手）"
        tpl = SLIM_PROMPT if self.model.lower().startswith("deepseek") else PLAN_PROMPT
        prompt = tpl.format(
            task=self.task, w=w or "?", h=h or "?",
            history=hist, keys_help=KEYS_HELP,
        )
        try:
            raw = await self.llm.read_image(data, "image/jpeg", model=self.model, prompt=prompt)
        except Exception as e:
            # 看图模型在某个分组不存在是**常态**（2026-10-10 日志：qwen3.7-plus 404 了一整天，
            # 每张截图都当没图）。这里只换一次，换过还不行就往上抛，让循环停手
            # ModelMissing：模型不存在（项目里踩过一整天）；EmptyContent：模型把预算全烧在"思考"上、
            # 什么都没吐出来（deepseek 实测偶发）。两种都换备用模型重跑这一步，别整轮停下。
            if (type(e).__name__ in ("ModelMissing", "EmptyContent") and self.fallback_model
                    and self.fallback_model != self.model):
                log.warning("看图模型 %s 这次没用上（%s），换备用 %s 重跑这一步", self.model, type(e).__name__, self.fallback_model)
                # **只换这一步**，下一步还用主模型：deepseek 回空是偶发的，而备用 qwen 一步要 6~55 秒。
                # 以前换过去就不回来，2026-10-16 真机第 3 步回空一次，后面 5 步全用 qwen，一步慢了十几倍
                # 模型不存在（ModelMissing）是另一回事：那是整天都不在，换过去就别再回来试
                used = self.fallback_model
                if type(e).__name__ == "ModelMissing":
                    self.model = used
                self._used_fallback = True
                # 提示词按**备用模型**重挑：qwen 用瘦身版会点偏 332 像素（见 SLIM_PROMPT 上面那段）
                tpl = SLIM_PROMPT if used.lower().startswith("deepseek") else PLAN_PROMPT
                prompt = tpl.format(task=self.task, w=w or "?", h=h or "?", history=hist, keys_help=KEYS_HELP)
                raw = await self.llm.read_image(data, "image/jpeg", model=used, prompt=prompt)
                log.info("AI 操作员判断（%s，备用）：%s", used, " ".join(str(raw).split())[:300])
                return self._vet(parse_decision(raw))
            else:
                raise
        log.info("AI 操作员判断（%s）：%s", self.model, " ".join(str(raw).split())[:300])
        return self._vet(parse_decision(raw))

    def _vet(self, d: Decision | None) -> Decision | None:
        """护栏：危险词、账号密码。主模型、备用模型的回包**都得过这一道**。"""
        if d is None:
            return None
        # **只查自然语言字段**（why / text）：keys 里是按键名，拿词表去匹配会把
        # ⌘（COMMAND）这种正常按键误判成「想跑命令」
        for word in FORBIDDEN_HINT:
            if word in f"{d.why} {d.text}".lower():
                log.warning("AI 操作员：模型的说明里出现了「%s」，按不合规处理", word)
                return None
        # 账号密码一律用户自己输：这一步只要沾上账号/密码/验证码，就停手
        if d.action in ("type", "press", "hotkey") and (
            looks_like_credential(d.text)
            or any(w in f"{d.why} {d.text}".lower() for w in CREDENTIAL_WHY_HINT)
        ):
            log.warning("AI 操作员：这一步要输账号/密码/验证码（%s），按规矩停手让用户自己输",
                        " ".join(f"{d.action} {d.why} {d.text}".split())[:120])
            self_refused["why"] = "credential"
            return None
        return d

    async def _act(self, d: Decision) -> str:
        """执行一步。返回追加在历史那一行后面的话（实时画面下会写「画面没变」）。"""
        if self.dry_run:
            log.info("[演练] 本来要执行：%s", d.summarized)
            return ""
        if d.action == "wait" and self.screen is not None:
            # 实时画面下「等一下」= 看着画面等它动起来、再等它停下，比死等 800ms 靠谱
            _, changed = await self.screen.wait_settled(self._frame, react=3.0, timeout=5.0)
            return "（等了画面也没变）" if changed is False else ""
        if d.action == "click":
            await self.op.click(self.session, d.x, d.y)
        elif d.action == "type":
            if d.x or d.y:
                await self.op.click(self.session, d.x, d.y)   # 模型想「点到那儿再输」，照它做
                await self.op.wait(self.session, 300)
            await self.op.type_text(self.session, d.text)
        elif d.action == "press":
            await self.op.press(self.session, d.keys)
        elif d.action == "hotkey":
            await self.op.hotkey(self.session, d.keys)
        elif d.action == "scroll":
            await self.op.scroll(self.session, d.x, d.y, direction=d.direction, count=3)
        elif d.action == "wait":
            await self.op.wait(self.session, 800)
        if self.screen is None:
            await self.op.wait(self.session, 600)   # 没有实时画面：给远端界面一点反应时间，下一步的截图才准
            return ""
        # 有实时画面：看着它变完再往下走；**确定**没变才告诉模型「那一下没生效」，
        # 说不准（None）就不提 —— 把点中了说成没生效，模型会去换做法，比不提示更糟
        _, changed = await self.screen.wait_settled(self._frame)
        return "（之后画面没变化）" if changed is False else ""


def build_llm(settings: Any) -> Any:
    """按项目现有配置建一个看图用的 LLM（`LLM_*` 那组 key，跟 embedding 同一个 client）。"""
    from ..kb.llm import LLM     # 延迟导入：没有问答需求时不该拉起 httpx 客户端

    return LLM(
        settings.llm_base_url, settings.llm_api_key,
        chat_model=settings.chat_model, embed_model=settings.embedding_model,
        embed_base_url=settings.llm_base_url, embed_api_key=settings.llm_api_key,
    )


def now() -> float:
    return time.time()
