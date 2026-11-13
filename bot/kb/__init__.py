"""AI 问答（阶段 5）。

一条提问的旅程见 answer.py，各模块分工：
    text.py      纯文本处理：2-gram 分词、资料切块、事实提取。无依赖，离线可测
    store.py     SQLite 存储（data/qa.db，不碰已上线的 approvals.db）
    llm.py       中转站客户端（OpenAI 兼容：chat + embeddings）
    retrieve.py  混合检索：向量余弦 + FTS5 关键词
    cluster.py   相似问法归并成一个「问题」，日报统计才不会被拆散
    answer.py    回答编排 + 重写自检
    sync.py      知识库.md 的导出与反向加载
    report.py    每日日报
    ingest.py    资料导入（命令行）
"""
