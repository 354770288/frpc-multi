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

## EvidenceBundleDraft

- Artifact key: workspace-validator
- Type: diagnostic
- Source: aegis-workspace.py check
- Summary: 工作记录proof bundle已生成；修复INDEX旧相对路径遗漏。治理文档校验仍因历史BASELINE-GOVERNANCE格式与当前helper要求不同而失败（任务开始时已存在）；文档要求显式用户审查才改，未更改该治理文档。产品与测试验证独立通过。
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: ui-browser
- Type: browser
- Source: 127.0.0.1:18081隔离QA
- Summary: 观测来源QA vsConsole指标隔离；0ms与上传0Mbps保留；跨节点对比路由59.43跳点；第1和2页选2目标换来源保留；quick能力不足后scope仍2目标；2node×2target=4pending；skip1 stop3 retry4与刷新同jobID恢复通过；全局LB观测节点/24h保存成功。新增stageCounts全批次聚合26focused通过；最新后端243全量通过35.766s
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: frontend-final
- Type: test
- Source: webui/frontend; /tmp/frpc-probe-frontend-race-check.cjs
- Summary: 前端独立spec/quality复审通过；父fresh npm run build通过index-tZWTmKbC.js；真实源码harness 5异步竞态+8地址解析边界通过；类型检查通过。后端stageCounts聚合及升级命令接口集成最新243tests通过。主控旧服务当前无运行测试/扫描/路由任务。
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: dns-endpoint
- Type: test
- Source: app/lb/selection.py; tests/test_lb_selection.py
- Summary: 部署前复现带端口候选地址成为无效A内容；修复DNS输出与健康API池为裸host，观测仍按host+port。40项LBtests通过，独立spec与quality均PASS。原ff49736 CI构建成功，新窄修复将另发镜像。
- Verifier: coordinator

## EvidenceBundleDraft

- Artifact key: rollout-query-repair
- Type: performance
- Source: 主控隔离容器+真实只读备份；tests/test_probe_jobs.py
- Summary: bf38e29首次上线服务器分页超过10秒，已回滚旧镜像，旧服务分页0.392秒；根因为source视图历史×资产地址函数JOIN和相关子查询。修复为每资产索引seek最新结果、临时索引只读投影，历史直接canonical。回归旧实现触发500000 SQLite VM步骤上限，新实现27focused通过。主控同机Linux容器真实备份：page49ms/allstatus57ms/dashboard32ms，integrity ok，历史1000首屏/测速94保留。点查IP过滤下推SQL。国内官方frp缓存传输SHA256两端一致，二进制0.68.1已验证，安装器支持显式FRPC_ARCHIVE避免下载受限。
- Verifier: coordinator
