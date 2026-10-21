# 全功能测试节点 - Evidence

本文件保留分阶段证据；最终验收以末尾 deployment-final 为准。

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

## EvidenceBundleDraft

- Artifact key: deployment-final
- Type: deployment
- Source: 23.19.228.204:8081 与 10.144.1.5；代码 da8603c；CI 39600936597
- Summary: 双节点在线且版本/四项能力一致，真实扫描autoFull共8阶段done；任务跨主控重启恢复、运行取消及子进程/端口清理通过；国内来源24h与主控独立健康检查生效；临时Cloudflare域名选优、离线、故障切换、恢复策略和池调整后同步通过；全部临时资源清理，原业务域名和管理实例保持正常。
- Verifier: coordinator

### 可追溯任务与测量

| 项目 | ID / 结果 |
| --- | --- |
| 双节点扫描及完整流程 | 53f6f258-64e8-4878-b134-bc70a9a6fefc，8 done |
| 节点离线排队、主控重启恢复 | ed58cf17-e428-4f4c-b5f9-760aea1c0faf，同 ID，最终 done |
| 运行中取消测速 | 66daab4e-ae76-43c4-a44a-c8d1d975f470，stopped，frpc 子进程及 11560–11562 监听均无残留 |
| Console → 受控 frps:17000 | 1 跳；穿透三项通过；下行 3593.85 / 上行 3689.06 Mbps，各20秒，同机回环 |
| 深圳电信 → 同一目标 | 16 跳；穿透三项通过；下行 1.13 / 上行 2.09 Mbps，下行20秒、上行含耗时25.8秒 |

两节点发现结果、路由跳点、CN2=false、穿透和测速字段由 compare API 分别读取并断言；下载与上传实际字节均大于0。测量是本次样本，不代表网络吞吐承诺。

### 真实 DNS 与恢复策略

临时域名 probe-qa-de43ff.zmfrp.eu.org、临时分组 _qa_probe_de43ff，仅关联本次创建的2条资产，没有迁移既有资产。国内观测首次选中23.19.228.204，Cloudflare A记录不含17000端口。关闭国内节点后，主控健康检查时间仍前进、健康当前IP保持；再关闭受控frps，连续失败后真实A记录切换122.9.56.235。恢复节点及frps后，主控探测恢复成功，按已批准的缺观测保守策略保留健康备用IP；将临时备用资产移出验收分组后手动同步，记录重新指向23.19.228.204。

分组“手动完整测试”链接正确预填完整测试、分组与国内执行节点；进入前后批次数均3，没有自动创建任务。真实4个业务域名全程保持原IP：cnix.isp0.de→122.9.56.235、eu1.zmfrp.eu.org→38.59.224.16、hk1.zmfrp.eu.org→1.32.216.28、us1.zmfrp.eu.org→154.17.231.55。

### 最终运行与清理回读

- API健康ok；Console与国内worker均在线/da8603c/四项能力；3个管理Agent在线，3个实例running，0 stopped/error。
- 2319资产、9原分组、4原域名；发现多出1条本次真实受控目标记录。3个验收批次均终态，历史保留。
- SQLite integrity_check=ok。真实备份迁移前后6表逐行一致，最终镜像隔离真实库验证page40ms/allstatus43ms/dashboard38ms；最终跨网HTTP服务器分页约0.43s。
- 临时域名删除后用配置的Cloudflare客户端回读记录数0；临时资产2320/2321及分组已删；受控frps服务停止、单元移除并daemon-reload；17000/11560–11562无监听；两个隔离查询容器已移除。
- 国内frpc-probe为enabled/running，worker.env权限0600，frpc0.68.1；旧frpc-route停用并保留配置以支持回滚。
- 后端最终247项测试通过（约36秒），前端tsc+vite构建通过；5项异步竞态、8项端点边界通过。CI构建amd64/arm64均成功，真实部署与安装验收仅amd64。

### 风险和完成边界

置信度B：直接线上证据覆盖约定的本次功能、恢复和DNS行为；公网路径及单次测速受当时网络状态影响。未做真实arm64主机安装、长期掉线浸泡或千万目标实际扫描；千万IPv4的有界性由既有回归及分块实现覆盖。自定义端口的发现导入沿用既有行为，未扩展该语义。

修复轨迹为先回滚生产查询回归，再以索引投影替代历史与资产的乘积连接；没有增加第二任务所有者。旧入口仅适配规范化任务，旧历史只读兼容；原路由服务保留至全部旧节点升级及回滚窗口结束。凭据不入仓库。
