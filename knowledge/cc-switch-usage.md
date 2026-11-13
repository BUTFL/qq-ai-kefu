# CC Switch 的额度查询 / 检测（2026-10-16 实测）

## 额度查询：灵眸是支持的

CC Switch 的「额度查询」走灵眸的用量接口，**这个接口是支持的**（2026-10-16 用真 key 实测）：

- 请求：`GET https://api.lmuai.com/v1/usage`，Header 带 `Authorization: Bearer <sk- 开头的密钥>`
- 返回 200，里面有 `balance`（余额）、`planName`（套餐名）、`remaining`、`isValid`、`daily_usage`（27 天每日用量）
- 不带密钥请求 → `401 API_KEY_REQUIRED`
- CC Switch 的程序里确实带着 `/v1/usage` 这个路径，它就是能查

所以 **CC Switch 里显示「额度没查到」、或者检测请求失败，都不代表 key 不能用**。

## 怎么判断 key 到底能不能用

别拿 CC Switch 的额度/检测结果当结论，直接用真实会话测最准：

1. 在 Claude Code 里新开一个会话，发一句话
2. 接口地址填 `https://api.lmuai.com`（Anthropic 协议的地址不带 `/v1`）
3. 能正常回就是能用；发消息也报错的话，把那个报错截图发出来给售后看

## 话术上不许说「不支持」

**不要说「灵眸不支持额度查询」「灵眸不支持检测」** —— 这与事实不符。
（2026-10-16 真机答错过一次：客户问 CC Switch 里额度查询查不到是不是 key 不能用了，
机器人回了一句「CC Switch 里的额度查询和检测灵眸这边不支持」，被运营当场纠正。）
正确说法：**额度查询是支持的；显示查不到、请求失败不代表 key 不能用，按上面第二条测一下最准。**
