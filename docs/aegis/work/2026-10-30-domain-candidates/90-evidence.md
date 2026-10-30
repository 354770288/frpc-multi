# 域名候选池改造验证

- 后端：`PYTHONWARNINGS=ignore::ResourceWarning DATABASE_PATH=/tmp/frpc-domains-verified-20261030.db ../../.venv/bin/python -m unittest discover -s tests`（webui/backend）——397 项，69.200 秒，OK。ResourceWarning 为此前测试资源告警，本轮没有隐藏测试失败。
- 新增存储、运行时和 API 覆盖：独立候选集合、旧组全部迁移及幂等/事务失败重试、10,001 项额外资产迁移、跨域名隔离/搜索分页、无效 ID 原子失败、固定优先、健康失败回落后不回切、无健康保留当前记录、Cloudflare 创建和删除失败、旧调度快照、单项/批量删除与 IP 编辑等待 DNS 提交。
- 独立复审发现的 API 响应字段分歧已与前端统一为 `{ok,total}`。服务器删除及 IP 修改竞态已在共享协调所有者 `lb/coordination.py` 收口，并有阻塞式线程测试。共享锁不加载认证/系统设置，独立存储测试不依赖 Web 启动环境。
- 生产备份：只读下载已有 `console-before-policy-e67e8a2-20261030.db`，两端 SHA-256 匹配。在本地隔离副本连续迁移两次，共 0.226 秒；每个域名成员集合与升级前分组服务器 ID 集合完全相等，候选数量按域名 ID 为 `{1:5,2:2,3:2,4:5}`，当前 IP/Zone 保留，完整性检查为 ok。
- 保留的事实行数：资产 2,319，发现记录 35,939，历史 2,498，审计 24,351。副本、临时凭据目录及检查脚本均已清理，远程只读会话已关闭。本轮未写生产库或 DNS。
- 协调者最终前端验证：`npm run build` 成功；Vitest 7 文件/15 项通过；`npm run test:e2e -- e2e/lb-domain-candidates.spec.ts e2e/test-creation.spec.ts --grep 'domains use|LB settings|unknown domain health' --workers=1`——3 项通过，12.0 秒。覆盖不绑定分组创建、跨页候选选择/移除、未启用域名的手动操作、当前 IP 固定、切换失败保留输入/成功固定、测量时间及零速率、空池移除确认、设置兼容与未知健康展示。
- 复审最后指出的服务器 IP 编辑竞态也已通过同一协调锁封闭，仅 IP 修改需要该锁；新增线程屏障测试验证顺序。目标验证范围未包含真实 Cloudflare 写入或新版本生产部署，也未重跑此前已有游标问题的完整浏览器套件。
