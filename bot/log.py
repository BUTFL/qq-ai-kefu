"""日志：控制台 + logs/bot.log 按天轮转，留 14 天。

logs/ 已在 .gitignore 里。审计日志（谁让机器人踢了谁）是阶段 2 的事，会单独走库，不混在这里。
"""
from __future__ import annotations

import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from .config import ROOT

LOG_DIR = ROOT / "logs"
_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"


def setup(level: str) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    fmt = logging.Formatter(_FORMAT, datefmt="%m-%d %H:%M:%S")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)

    file = TimedRotatingFileHandler(
        LOG_DIR / "bot.log", when="midnight", backupCount=14, encoding="utf-8"
    )
    file.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers[:] = [console, file]

    # websockets 库在 DEBUG 下会把每个帧都打出来，太吵；只有我们自己开 DEBUG 时才放开
    logging.getLogger("websockets").setLevel(logging.DEBUG if level == "DEBUG" else logging.WARNING)
