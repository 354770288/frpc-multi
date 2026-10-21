# 全功能测试节点 - Evidence

No evidence has been recorded yet.

## EvidenceBundleDraft

- Artifact key: lb-regression
- Type: test
- Source: webui/backend/tests/test_lb_selection.py
- Summary: 37项LB回归通过；含真实统一Console任务及外部节点最新失败覆盖旧成功；需求与质量独立复审通过
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: production-backup
- Type: deployment
- Source: 23.19.228.204:/data/console-before-probe-workers-20261021.db
- Summary: SQLite在线备份成功；旧镜像tag frpc-multi:rollback-probe-workers-20261021；国内节点10.144.1.5旧frpc-route在线；临时frps17000配置verify成功，尚未启动
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: migration-real-backup
- Type: migration
- Source: 线上备份的本地副本（受限临时目录）
- Summary: 真实库重复迁移后6张原资产/历史/分组/域名表逐行完全一致；2319服务器35938发现2392连通94测速9分组4域名；integrity_check=ok；Console来源分页本机15ms/36ms，facets122ms，dashboard10ms
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: backend-final
- Type: test
- Source: webui/backend/tests
- Summary: 父fresh全量242项测试通过35.997秒；backend spec与quality独立审查均通过；真实库历史Console可见conn第一页1000条和speed94条；修复legacy快照可见性、端口alias、retry gate和infra分类
- Verifier: coordinator
