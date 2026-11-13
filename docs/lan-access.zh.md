# 局域网访问

默认所有端口只绑 `127.0.0.1`（仅本机）。要让局域网其它设备访问协议端 WebUI(3000) 与控制台接口(8090)，用 `lan` 服务。

## 开启

1. `.env` 里填这台机器的局域网 IP：

   ```
   LAN_IP=192.168.1.10
   ```

2. 起 lan 服务：

   ```bash
   docker compose up -d lan
   ```

   它把 `LAN_IP:3000 → protocol:3000`、`LAN_IP:8090 → bot:8090` 原样转发（`scripts/lan_proxy.py`，不看内容）。

3. 局域网里浏览器开 `http://192.168.1.10:3000`（协议端）或 `:8090`（控制台 API）。

- 换了局域网 IP：改 `.env` 的 `LAN_IP`，`docker compose up -d lan`（不动 protocol/bot，QQ 不掉线）。
- 停局域网访问：`docker compose stop lan`，回到只有本机能开。

## 安全（务必）

- **绝不要把 3000/8090/6081 绑到 `0.0.0.0` 或暴露公网**：拿到协议端 WebUI 等于拿到这个 QQ 号的完全控制权。
- `LAN_IP` 不填时默认落到 `127.0.0.2`，等于没开。
- 远程（跨网）访问用 **SSH 隧道**，不要开公网端口：

  ```bash
  ssh -L 3000:127.0.0.1:3000 -L 8090:127.0.0.1:8090 user@你的服务器
  # 然后本机浏览器开 http://127.0.0.1:3000
  ```
- 协议端的高危 Cookie/SKey 提取接口默认已关（`ROSMONTIS_ENABLE_WEB_CREDENTIAL_API=0`），别打开。
