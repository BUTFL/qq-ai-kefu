#!/usr/bin/env python3
"""把 需求与方案.md / 开发文档.md / 进度.md 合成一份 项目文档.md。

管理员 2026-09-24 批复「合并三份根文档」。我原先建议不合（理由：跟他同一批要的
「压缩上下文」打架，22 万字合成一份之后每次都得整份拖进来），他看过理由后仍然要合，照办。

**为什么留着这个脚本**：原件删掉之前，`项目文档.md` 是生成物。改了原件不重跑，
合并件就是旧的，而两边都在仓库里，下一个人分不清哪份是准的。原件删掉之后
这个脚本就没用了，跟着删。

三条硬约束：
1. **代码块里的 `#` 一行都不能动。** 那是 shell 注释，他会复制粘贴去跑，三份里共 24 行。
   机械地把行首 `#` 当标题降级会把命令改坏。所以解析是跟着 ``` 围栏走的。
2. **只改标题层级，一个字的正文都不改。** 合并不是重写。
3. **不删原件。** 删原件不可逆，什么时候删由管理员定。

用法：
    uv run scripts/merge_docs.py        # 生成
    uv run scripts/merge_docs.py -v     # 生成 + 逐行核对没丢字
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "项目文档.md"

# 顺序有讲究：需求在前（为什么做）、开发文档居中（怎么做）、进度在后（做到哪了）。
# 这也是三份的寿命顺序：需求基本不动，开发文档按任务翻，进度只往后追加。
SOURCES = [
    ("需求与方案.md", "第一部分　需求与方案", "定了做什么、不做什么。基本不再变动。"),
    ("开发文档.md", "第二部分　开发文档", "代码地图、怎么加功能、环境命令、排错。按任务翻这一部分。"),
    ("进度.md", "第三部分　进度", "做到哪了、踩过什么坑、每条结论的来龙去脉。只往后追加。"),
]

FENCE = re.compile(r"^\s*(```|~~~)")
HEAD = re.compile(r"^(#{1,6})(\s+\S.*)$")


def shift(name):
    """把一份原件的标题整体降一级，顺带收目录。返回 (降级后的行, 目录条目)。

    原件的 H1 直接扔掉——它的位置被「第 N 部分」那行顶替了，留着就是两个标题叠一起。
    目录只收到 H3（降级后），再深就没人看了。
    """
    lines = (DOCS / name).read_text(encoding="utf-8").splitlines()
    out, toc = [], []
    in_code = False
    for lineno, ln in enumerate(lines, 1):
        if FENCE.match(ln):
            in_code = not in_code
            out.append(ln)
            continue
        if in_code:
            out.append(ln)  # 代码块内原样抄，`#` 是 shell 注释
            continue
        m = HEAD.match(ln)
        if not m:
            out.append(ln)
            continue
        level = len(m.group(1))
        if level == 1:
            continue
        out.append("#" * (level + 1) + m.group(2))
        if level + 1 <= 3:
            toc.append((level + 1, m.group(2).strip(), name, lineno))
    return out, toc


def build():
    """拼出整份 项目文档.md 的文本。"""
    parts, all_toc = [], []
    for name, title, hint in SOURCES:
        body, toc = shift(name)
        parts.append((name, title, hint, body))
        all_toc.append((title, toc))

    doc = [
        "# 灵眸助手　项目文档",
        "",
        "这一份是 `需求与方案.md`、`开发文档.md`、`进度.md` 三份合起来的，内容一个字没改，",
        "只把每份的标题整体降了一级，好塞进同一个目录里。",
        "",
        "⚠️ **这份是生成的，别直接改它。** 原件还在的这段时间里，改了任一份原件之后重新跑：",
        "",
        "```sh",
        "uv run scripts/merge_docs.py      # 重新生成这份",
        "uv run scripts/merge_docs.py -v   # 顺带核对一个字没丢",
        "```",
        "",
        "要改内容就改原件。原件哪天删了，这个脚本也跟着删，那时这份才变成正本。",
        "",
        "---",
        "",
        "## 目录",
        "",
    ]
    for title, toc in all_toc:
        doc.append(f"- **{title}**")
        for level, text, src, lineno in toc:
            doc.append("  " * (level - 1) + f"- {text}　<sub>{src}:{lineno}</sub>")
        doc.append("")

    for name, title, hint, body in parts:
        doc += ["", "---", "", f"## {title}", "", f"> {hint}　原件：`{name}`", ""]
        while body and not body[-1].strip():
            body.pop()  # 原件末尾的空行，不然部件之间会空出一大片
        doc += body

    return "\n".join(doc).rstrip() + "\n"


def slice_part(out_lines, title):
    """从合并件里切出某一部分的正文（不含「## 第 N 部分」那行和它下面的一句说明）。"""
    start = out_lines.index(f"## {title}")
    end = len(out_lines)
    for i in range(start + 1, len(out_lines)):
        if out_lines[i].startswith("## 第"):
            end = i - 3  # 退回到下一部分前面那组 "" / "---" / "" 之前
            break
    # 标题行下面是 空行 / 一句说明 / 空行，正文从第四行起。
    return out_lines[start + 4 : end]


def verify():
    """逐行核对：正文一个字没改，标题只降了一级，代码块里的 `#` 没被当标题处理。

    这里刻意不复用 shift() 的结果去比——那样是自己跟自己对，shift() 有 bug 也看不出来。
    比的是**原件**和**合并件**，降级规则在这边独立写一遍。
    """
    out_lines = OUT.read_text(encoding="utf-8").splitlines()
    ok = True
    for name, title, _hint in SOURCES:
        src_lines = (DOCS / name).read_text(encoding="utf-8").splitlines()
        got = slice_part(out_lines, title)
        gi = 0
        in_code = False
        bad = []
        fence_hash = 0
        for lineno, ln in enumerate(src_lines, 1):
            if FENCE.match(ln):
                in_code = not in_code
                want = ln
            elif in_code:
                want = ln
                if ln.lstrip().startswith("#"):
                    fence_hash += 1
            else:
                m = HEAD.match(ln)
                if m and len(m.group(1)) == 1:
                    continue  # 原 H1 被部件标题顶替，合并件里不该有
                want = "#" * (len(m.group(1)) + 1) + m.group(2) if m else ln
            # 最后一部分的末尾空行被整份的 rstrip() 削掉了，只有空行允许越过末尾。
            if gi >= len(got) and not want.strip():
                gi += 1
                continue
            if gi >= len(got) or got[gi] != want:
                bad.append((lineno, ln, got[gi] if gi < len(got) else "<到头了>"))
                if len(bad) >= 5:
                    break
            gi += 1
        tail = [x for x in got[gi:] if x.strip()]
        if bad:
            ok = False
            print(f"❌ {name} 对不上：")
            for lineno, want_ln, got_ln in bad:
                print(f"   原件 {lineno} 行 {want_ln!r}\n   合并件      {got_ln!r}")
        elif tail:
            ok = False
            print(f"❌ {name}：合并件里多出 {len(tail)} 行原件没有的内容，头一行 {tail[0]!r}")
        else:
            print(
                f"✅ {name}：{gi} 行一字不差、顺序一致，"
                f"代码块里 {fence_hash} 行 `#` 原样保留"
            )
    return ok


if __name__ == "__main__":
    OUT.write_text(build(), encoding="utf-8")
    print(f"已生成 {OUT.name}：{OUT.stat().st_size} 字节 / {len(OUT.read_text(encoding='utf-8').splitlines())} 行")
    if "-v" in sys.argv[1:]:
        sys.exit(0 if verify() else 1)
