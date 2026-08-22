"""frps 节点验收测试（穿透测试）模块。

移植自独立工具「FRPC穿透测试」：对候选 frps 服务器做
tcping 探活 → 拉起 frpc 建隧道 → 验证远端映射端口放行 → 双隧道实测上下行速率，
结果由 store 落 SQLite，经 router 暴露 /api/probe/* 供面板调用。
"""
