"""远程协助：让机器人操作客服机上的向日葵（或 ToDesk），去客户电脑上做事。

四个文件，一层管一件事：

- `mcp_client.py` —— 协议层。跟远控软件自带的 MCP 说话（HTTP / SSE / stdio），并负责建客户端。
- `provider.py`   —— 方言层。语义动作 → 各家工具名和参数形状；两家的差别都收在这里。
- `operator.py`   —— 规矩层。白名单分档、审批、上限、审计。**机器人只走这里。**
- 本文件         —— 出口。

**当前哪条能走（2026-10-16 实测）**：向日葵。它的 MCP 走 stdio，客户端里开「向日葵MCP」后
配好 `AWESUN_API_URL` + `AWESUN_API_TOKEN` 就能用，`control_connect` 支持 `fastcode`
（不在账号里的设备也能连）——客户报个识别码就够了。
ToDesk 的 MCP 绑在「AI 审计 / ToClaw AI」那套上，要登录且没找到普通开关，先留着备用。

规矩（大哥 2026-10-16 定的）：**必须客户同意才开始远程**，所以 `connect` 卡在审批门上；
默认档 `assist` 够「帮客户配中转站」，执行命令要显式开 `full`。
"""
from __future__ import annotations

from .mcp_client import McpClient, McpError, McpUnavailable, for_provider  # noqa: F401
from .operator import RemoteOperator, RemoteRefused, Session, mask_target, scrub  # noqa: F401
from .provider import AWESUN, PROVIDERS, TODESK, Provider, pick  # noqa: F401

__all__ = [
    "McpClient", "McpError", "McpUnavailable", "for_provider",
    "RemoteOperator", "RemoteRefused", "Session", "mask_target", "scrub",
    "Provider", "AWESUN", "TODESK", "PROVIDERS", "pick",
]

