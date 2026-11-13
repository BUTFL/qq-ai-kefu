"""同一个任务、同一张截图，比两个看图模型的**准度 + 单步耗时**（dry-run，只看不点）。

    uv run scripts/compare_vision.py --code 399999003 --trials 3

为什么要这个：2026-10-16 大哥说 deepseek-v4.1-flash 也很快，让比一比再决定换不换
（操作员每步都要调一次看图模型，这里省下来的时间会乘以步数）。

比的是**点得准不准**，不是谁快：
- 先把机器当前画面截一张，两个模型看**同一张图**、回答**同一个问题**；
- 每个目标问 N 次，用 `parse_decision` 抠动作（抠不出来算"废动作"）；
- 拿模型给的点跟人肉量的真实位置比距离（归一化坐标 ×1728/1080 → 像素），
  超过 35 像素就算没点中。

真实位置是拿着截图量的（见 TARGETS 里的注释），换了屏幕/窗口位置要重新量。
"""
from __future__ import annotations

import asyncio
import pathlib
import statistics
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bot.config import Settings  # noqa: E402
from bot.remote import RemoteOperator, for_provider, pick  # noqa: E402
from bot.remote.assist import PLAN_PROMPT, build_llm, parse_decision, shot_bytes  # noqa: E402

# 两个模型：qwen 是现在线上用的，deepseek 是大哥点名要试的
MODELS = ["qwen3.7-plus", "deepseek-v4.1-flash"]

# 目标 + 我在截图上量出来的真实位置（归一化；1728x1080 下 1 像素 = 0.00058）
TARGETS = [
    ("点『名称』输入框", "在「创建密钥」弹窗里点『名称』标签下面那个输入框，好让下一步能往里面打字", (0.457, 0.302)),
    ("点右下角『创建』按钮", "在「创建密钥」弹窗里点右下角那个绿色的『创建』按钮（别点成旁边的「取消」）",
     (0.570, 0.762)),
]

W, H = 1728, 1080
HIT_PX = 35.0        # 离真实位置 35 像素以内算点中


# 瘦身版提示词：目标是把「思考」压到最少（实测 qwen 86 秒里有 5348 个 token 是思考）
SLIM_PROMPT = """你在通过远程控制软件操作客户自己的电脑。只做一件事：给出下一步的**那一个动作**。

任务：{task}
屏幕：{w} x {h} 像素（坐标换算成 0~1 的小数，左上角是 0,0）
已经做过的步骤：
{history}

**只输出一行 JSON，不要解释、不要 markdown、不要思考过程、不要换行：**
{{"action":"click","bbox":[左,上,右,下],"why":"不超过15字"}}

其它动作的写法（同样只给一行）：
{{"action":"type","text":"要输的字","why":"…"}} / {{"action":"press","keys":["RETURN"]}} /
{{"action":"hotkey","keys":["COMMAND","A"]}} / {{"action":"scroll","bbox":[左,上,右,下],"direction":"down"}} /
{{"action":"wait"}} / {{"action":"done"}} / {{"action":"give_up"}}

优先给 bbox（我取它的中心点）。要打字先 click 输入框。拿不准就 give_up。
按键名只认这些：{keys_help}
禁止：关机 / 重启 / 删除文件 / 打开终端跑命令 / 输入账号密码验证码。"""


def flag(name: str, default: str = "") -> str:
    args = sys.argv[1:]
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default


async def grab(code: str) -> tuple[bytes, float, float]:
    """连上去截一张图（不点任何东西）。返回 (图片字节, 宽, 高)。"""
    s = Settings.load(); p = pick(s.remote_provider)
    url, token = (s.awesun_mcp_url, s.awesun_api_token) if p.key == "awesun" \
        else (s.todesk_mcp_url, s.todesk_mcp_token)
    c = for_provider(p, url=url, token=token, transport=s.remote_transport)
    await c.connect()
    op = RemoteOperator(c, provider=p, actor="模型对比-只截图")
    sess = await op.start_session(op.session(code, customer="对比测试", approved_by="大哥授权验证").session)
    try:
        await op.connect(sess)
        shot = await op.screenshot(sess)
        data = shot_bytes(shot)
        if not data:
            raise RuntimeError("截图没取到")
        out = pathlib.Path(ROOT / "data" / "compare_shot.jpg")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(f"截图：{out}（{len(data)} 字节）")
        return data, float(shot.get("image_width") or W), float(shot.get("image_height") or H)
    finally:
        try:
            await op.close_session(sess)
        except Exception:
            pass
        await c.aclose()


async def main() -> int:
    code = flag("--code") or "399999003"
    trials = int(flag("--trials", "3"))
    only = flag("--models")                       # 逗号分隔，默认两个都比
    which_prompt = (flag("--prompt", "both") or "both").lower()   # current | slim | both

    print(f"目标机器 {code}｜每个目标问 {trials} 次\n")
    data, w, h = await grab(code)
    s = Settings.load()
    llm = build_llm(s)
    rows: dict[tuple[str, str], list[tuple[float, bool, float, int]]] = {}
    try:
        for target_name, target_task, (tx, ty) in TARGETS:
            print(f"\n=== 任务：{target_name}（真实位置 {tx:.3f},{ty:.3f}）===")
            print(f"{'模型':<22}{'次数':<6}{'耗时(s)':<10}{'像素误差':<12}{'判定':<8}输出字符")
            variants = ["current", "slim"] if which_prompt == "both" else [which_prompt]
            for variant in variants:
              for model in (m.strip() for m in (only.split(",") if only else MODELS) if m.strip()):
                cell: list[tuple[float, bool, float, int]] = []
                for i in range(trials):
                    tpl = SLIM_PROMPT if variant == "slim" else PLAN_PROMPT
                    prompt = tpl.format(
                        task=target_task, w=int(w), h=int(h), history="（还没动手）",
                        keys_help="ESCAPE, RETURN, SPACE, TAB, DELETE, 方向键, COMMAND / SHIFT / CONTROL / ALT",
                    )
                    t0 = time.perf_counter()
                    try:
                        raw = await llm.read_image(data, "image/jpeg", model=model, prompt=prompt)
                    except Exception as e:
                        dt = time.perf_counter() - t0
                        print(f"{variant + '/' + model:<30}{i + 1:<6}{dt:<10.1f}{'-':<12}{type(e).__name__[:7]:<8}")
                        cell.append((dt, False, 999.0, 0))
                        continue
                    dt = time.perf_counter() - t0
                    d = parse_decision(raw)
                    if d is None or d.action not in ("click", "type"):
                        # type 也算能用（模型可能选择"点框并输入"），但没有坐标就算废
                        ok = False
                        err = 999.0
                    else:
                        err = (((d.x - tx) * w) ** 2 + ((d.y - ty) * h) ** 2) ** 0.5
                        ok = err <= HIT_PX
                    cell.append((dt, ok, err, len(raw or "")))
                    print(f"{variant + '/' + model:<30}{i + 1:<6}{dt:<10.1f}{err:<12.0f}{'✅' if ok else '❌':<8}{len(raw or '')}")
                rows[(target_name, variant + "/" + model)] = cell
    finally:
        await llm.close()

    print("\n\n================ 汇总 ================")
    print(f"{'任务':<22}{'模型':<22}{'平均耗时(s)':<14}{'中位耗时':<10}{'点中率':<10}{'平均字符'}")
    for target_name, _, _ in TARGETS:
        for key in [k for k in rows if k[0] == target_name]:
            model = key[1]
            cell = rows.get((target_name, model)) or []
            if not cell:
                continue
            dts = [c[0] for c in cell]
            hits = [c[1] for c in cell]
            chars = [c[3] for c in cell]
            print(f"{target_name:<22}{model:<22}{statistics.mean(dts):<14.1f}"
                  f"{statistics.median(dts):<10.1f}{sum(hits)}/{len(hits):<8}{statistics.mean(chars):<10.0f}")
    return 0


sys.exit(asyncio.run(main()))
