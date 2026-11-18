# frpc-multi 当前交接（更新于 2026-11-18）

> 接续工作先读本节，再读最新检查点与证据。下方 8 月记录保留用于追溯，其中的环境地址、测试数量和业务规则不代表当前状态。凭据仅通过 Netcatty vault 或现有受保护配置获取，不写入交接文档。

## 当前版本与接续入口

- 仓库：`/Users/zm/Documents/frpc-multi`，分支 `main`，已推送并部署上线。
- 当前线上功能提交：`e8081e32b08c8fe5e8460def3d8ca4a9e46718d5`（运行镜像标签 `frpc-multi:release-e8081e3`，`AGENT_VERSION=e8081e3`）；文档归档提交使用 `[skip ci]` 不改变运行镜像版本。
- 入口：[线上 Console](http://23.19.228.204:8081/)。2026-11-18 发布后已核对 revision、外网 HTTP 200、关键认证 API、数据库完整性、4 台在线 Agent 业务端口自动识别及首轮 GFW 屏蔽自动切换与业务端口异常告警。
- 最新交付事实（2026-11-18）：[本轮检查点](../docs/aegis/work/2026-11-18-delivery/20-checkpoint.md)、[全量验证与上线证据](../docs/aegis/work/2026-11-18-delivery/90-evidence.md)、[隔离备份恢复演练报告](../docs/aegis/work/2026-11-18-delivery/restore-rehearsal.md)、[目标网络响应分布报告](../docs/aegis/work/2026-11-18-delivery/response-distributions.md)。历史容量依据见 [服务器库容量证据](../docs/aegis/work/2026-10-23-server-library-scale/90-evidence.md)。

## 最新业务规则（优先于历史方案）

1. 测试资产按 IP 标识，目标端口固定 7000；frpc 实例自身配置的端口属于独立业务。
2. 只在测试节点页配置主用与有序备用，其他页面无执行节点选择/筛选或日常来源对比。其他完整能力外部节点作为备用，Console 固定最后；批次保存自己的节点顺序快照，代次与 attempt 校验拒绝旧回报。
3. 日常结果使用统一当前投影；历史保留实际执行者。域名选优仍由主控进行实时健康检查。
4. 域名候选以 `lb_domain_servers` 的明确服务器 ID 集合为事实来源，独立于分组筛选；旧分组曾一次性迁入候选池。**2026-11-17 用户明确修正：每台服务器只允许属于一个域名**，跨域名新增返回 409，整批回滚，不自动抢占。
5. 域名设置 `syncGroupId` / `syncGroup`。新增候选与移入该业务分组同事务；移除只清理真实成员且仍属于该配置组的归属，保留后来人工改组。显式改变同步分组会更新该域名现有全部候选，但不直接写 DNS。业务分组本身不反向扩展域名候选。
6. 手动“切换并同步 DNS”或“固定并同步 DNS”成功后，目标健康期间保持固定；健康失败后按原规则回落，成功切换后解除固定，不自动回切。保留健康阈值、单条托管灰云 A 和非托管记录保护；空候选池同步会清理托管 A，有候选但无健康目标时保留现有记录。
7. 本地 GeoIP 与托管自动标签已上线；人工标签、业务分组、测量状态各有独立含义。GeoIP 数据源、来源保护与容量依据见 [归属地工作记录](../docs/aegis/work/2026-10-30-ip-geoip/20-checkpoint.md)。
8. **2026-11-18 新增：优选域名业务端口健康检查与大陆 GFW 屏蔽自动切换 + 主页异常窗口**：
   - Console 追踪所有在线 Agent 上启用且运行中 `frpc` 实例关联到优选域名（或 `current_ip`）的 TCP `remotePort` 列表（`tcpRemotePorts`，升序去重，排除 UDP/STCP/XTCP 避免 TCP 握手误报；兼容未升级旧 Agent 回退拉取配置），持久化于 `lb_instance_ports`。
   - 后台调度器与手动「检测业务端口」按端口号升序，经 `ephemeral_tcping_broker`（`taskId` 前缀 `lb-tcping:`）复用现有主备测试节点轮询通道对 `current_ip:port` 执行零持久化污染的单点 TCP 探测（不写 `probe_jobs` / `probe_discover_results`，不破坏正式资产固定 `7000` 端口规则）：
     - **主节点不通 + 任一有序备用节点（外部备用或最终 `console`）通**：立即判定当前 IP 被大陆 GFW 防火墙屏蔽端口，写入 `lb_gfw_blocks` 隔离与 `gfw_blocked` 告警，并立即调用 `sync_domain` 切换候选池内其他健康未屏蔽 IP 解析到域名（若原 IP 处于手动固定态，切换成功后自动解除固定；`selection_for_domain` 与手动 `switch` 均排除活跃屏蔽 IP 防止乒乓回切；支持运维解封后手动解除屏蔽）。
     - **主备节点均不通**：判定为业务端口异常（`port_down`），写入/更新 `lb_port_alerts`，**不盲目切换 IP**。
     - **主节点离线或认领超时**：返回 `inconclusive`，不误判屏蔽或宕机。
   - 工作台主页（`/workspace`，`ResourceOverview.tsx`）新增「异常监控窗口」模块，集中展示业务端口异常、GFW 屏蔽切换/隔离告警及节点离线、实例故障、DNS 同步异常，支持一键检测、解除屏蔽与忽略告警。

## 本次新增交付与历史实库状态

- **2026-11-18 本地交付（待按需上线）**：
  - 新增后端模块 `app/probe/ephemeral_tcping.py`、`app/lb/port_health.py` 及 `database.py` 三张表（`lb_instance_ports`、`lb_gfw_blocks`、`lb_port_alerts`），暴露 `GET /api/lb/port-health`、`POST /api/lb/port-health/check`、`DELETE /api/lb/gfw-blocks/{ip}`、`POST /api/lb/port-alerts/{alert_id}/dismiss`。
  - 根治服务器库游标 `Back/Forward`“URL 恢复但缺少新页请求”缺陷（重构 `pages/probe/useServers.ts` 为 URL 权威源 + 同帧队列串联乐观投影 + `popstate` 释放），并将 2,101 行 `Probe.tsx` 模块化拆分为按路由懒加载的 `DiscoveryPage`、`ServersPage`、`TestsPage`、`ProbeDialogs`、`ProbeTableShared`、`ServerFilterControls`，补齐表头全选 `indeterminate` 半选态并移除冗余历史请求。
  - 新增 `scripts/backup-console.sh`、`scripts/rehearse-restore.py`（固化恢复时清理 `-wal`/`-shm`）、`scripts/analyze_probe_distributions.py`，升级双角色 `scripts/check-health.sh` 与 `docs/OPERATIONS.md`。
  - 清理 `probe/bulk.py` 与测试套件未关闭 SQLite 连接/Socket `ResourceWarning`，为 `probe/router.py` 6 处 `q` 参数增加 `max_length=256`，新增 `.github/workflows/ci.yml` 并在 `docker-publish.yml` 挂载发布前 `verify` 测试门禁。
- **2026-11-17 线上基线状态（`b75b558`）**：
  - HTTP 环境无 `crypto.randomUUID()` 兼容修复（`lib/requestId.ts`）、单域名排他索引 `idx_lb_domain_servers_one_domain` 与业务分组同步已在线运行。
  - 2026-11-17 授权调整后：`us1.zmfrp.eu.org` / 美国US1 / 9 台，`hk1.zmfrp.eu.org` / 香港1 / 2 台，`eu1.zmfrp.eu.org` / 欧洲EU1 / 2 台，`cnix.isp0.de` / 国内CN / 5 台；当时核对资产 2,319、测试历史 3,179、发现记录 35,939、候选关系 18 条。

## 部署、备份与回滚

- SSH 优先使用 Netcatty：主控 vault 标签 `Hostdzire-LAX`，23.19.228.204:35477；国内主节点标签 `ubuntu-work`，已更新地址为 10.144.1.5:22。8 月记录中的 10.144.1.3 已过时。复用适合会话，收尾仅关闭本次新建的会话。
- 主控部署目录 `/opt/frpc-multi`，Compose 文件 `compose.console.yaml`，容器 `frpc-console`，数据卷 `frpc-multi-console_console-data`，数据库 `/data/console.db`。
- 当前线上运行镜像标签 `frpc-multi:release-e8081e3`（已同步写入 `/opt/frpc-multi/.env` 的 `CONSOLE_IMAGE`）；回滚标签 `frpc-multi:rollback-before-e8081e3`（对应 `b75b558`）与 `frpc-multi:rollback-bugs-20261117`（对应 `1f09b4e`）均保留。
- 2026-11-18 发布前在线备份 `/data/console-before-e8081e3-20261118.db`（权限 0600，integrity_check=ok）及 `.env.before-e8081e3-20261118` 已保留；历史备份 `/data/console-before-domain-group-final-20261117.db` 也保留。日常在线热备可使用新增的 `scripts/backup-console.sh`。
- 卷在宿主机的目录 `/var/lib/docker/volumes/frpc-multi-console_console-data/_data`。回滚应先停止 Console、另存当前数据库、**删除目标路径残留的 `console.db-wal` 与 `console.db-shm`**，再恢复对应备份并启动旧镜像；标准隔离恢复演练已通过 `scripts/rehearse-restore.py --self-test` 验证（见 [演练报告](../docs/aegis/work/2026-11-18-delivery/restore-rehearsal.md)）。
- 发布前等待连通性批次自然完成；不要为升级擅自停止用户测试。随后做只读备份隔离迁移、核对镜像 revision，再切换服务。若同步升级 Agent 镜像，`get_summary()` 将直接附带 `tcpRemotePorts`；未升级 Agent 前 Console 亦会自动走 `get_config` 兼容回退采集业务端口。
- 停止态隔离容器 `frpc-fixes-preflight-20261117` 有意保留为验证证据。远程检查脚本 `/opt/frpc-multi/online-fixes-check-20261117.py` 的 repair 模式会执行已授权 US1 分组修复，不应在普通巡检时随意重跑；verify 模式为核对接口和归属。

## 验证与剩余事项

- 2026-11-18 本地全量回归：**后端 434 项单测全部通过（76.88s）**，`bulk`/`import`/`selection` 41 项在 `-W error::ResourceWarning` 下 **0 告警**；**前端构建通过、37 项 Vitest 单测全部通过、全套 60 项 Playwright 浏览器测试全部通过（32.1s）**；恢复演练与分布统计脚本自检通过。
- 后端依赖由仓库根目录 `.venv/bin/python -m pip install -r webui/backend/requirements.txt` 同步；从 `webui/backend` 运行 `../../.venv/bin/python -m unittest discover -s tests`，使用隔离 `DATABASE_PATH` / `PROJECT_DIR`，不要指向生产库。
- 前端在 `webui/frontend` 运行 `npm test`、`npm run build`、`npx playwright test`（Playwright 默认端口 5184，同一时间只运行一套服务）。
- 服务器库游标 Back/Forward 问题已根治并通过加强后的浏览器 E2E 验证关闭；隔离恢复演练已完成；目标网络响应分布统计工具与隔离基准报告已交付（若需真实公网样本分布，可在维护窗口对线上只读备份运行 `scripts/analyze_probe_distributions.py --db <backup.db>`）。
- 后续若需上线本轮改动：提交并推送到 `main`（自动触发 `ci.yml` 与带门禁的 `docker-publish.yml`），按上述停机前热备与隔离预演流程切换 Console（及按需更新 Agent），切换后强制刷新浏览器缓存。凭据、密码和 Token 不进入仓库或 Notion。

---

## 历史专项记录（2026-08-30，以下仅供追溯）

> 当时状态：专项完成。Task 1–6 全部实现、审查、验证并提交。当前接续以顶部 2026-11-17 摘要及其链接的最新证据为准。

## 0. 最终结论

服务端 + 前端性能链路全部落地：

- **扫描能力**：最多 **10,000,000 个去重扣除排除项后的有效 IPv4 目标**（原 262,144 上限的问题解决）；`TargetPlan` 冻结合并区间惰性迭代，不展开目标列表；扫描任务数与队列大小只随并发数增长（1 producer + N workers，queue maxsize=concurrency）。
- **数据库**：每 resolved DB path 只初始化一次（WAL + synchronous=NORMAL + busy_timeout 5000）；发现表 `ip_sort` 数值列 + 三个排序索引（time / ip asc / ip desc），分页查询零 TEMP B-TREE；invalid legacy IP 永驻 NULL、null-last 排序。
- **API**：`GET /discover/results` 服务端分页（{items,page,pageSize,total,sort,order}，pageSize≤200，sort=discoveredAt|ip|latency）；`GET /discover/facets` 独立；显式空串筛选（group=/label=）与 undefined 语义两端对齐；批量操作按 SQLite 变量上限分块且跨块原子；import 事务权威（selected-row 存在性唯一判据）；`ids=[]` no-op ≠ `ids=None` 清空。
- **落库**：每次扫描一个 `DiscoverScanCoordinator` + bounded queue + 单 writer 线程/连接 owner；按数量/时间批量提交、收尾 drain、commit 后才入 auto-route 队列；持久化失败（startup/runtime/final-drain）在扫描状态可见并安全终止。
- **前端**：`pages/probe/useDiscovery.ts` 单一 owner——query/单页/facets/跨页勾选/scan+route 状态；AbortController+generation 拒绝过期响应；单一递归 setTimeout 轮询（active 1.5s/空闲 6s，仅 Tab 激活且页面可见）；terminal 转换 hook 级 ref + 外部 setter seed + nudge（短扫描不漏检）；搜索 300ms 防抖；发现 Tab 条件渲染；批量改/删/导入统一 recoverOutOfRange。浏览器只渲染当前页——万行 DOM 卡顿问题消除。

## 1. 提交链（ce52f02 之后）

```
e2b1f6a perf(database): initialize SQLite once per path
78cc4e4 perf(probe): bound IPv4 discovery scanning
0e5b2c3 perf(probe): page and batch discovery results
dd42848 perf(probe): bound discovery persistence
2e84ea1 perf(probe): 前端网段发现迁移服务端分页（Task 5）
5fe70ff perf(probe): Task 6 收尾——综合审查修复 + 证据文档
1d1df03 docs(handoff): 性能优化上线记录与冒烟证据
6875687 perf(probe): 服务器库迁移服务端分页（2215 台全量 693KB→单页）
```

### 1.1 服务器库分页追加（6875687，2026-08-30）

用户实测「候选 frps 服务器」Tab 打开 2215 台要 30s。根因同网段发现：全量 693KB
JSON 跨洋传输 + 2215 行全量 DOM + 10s 全量轮询（后端本机仅 0.08s）。照同一模式改造：

- 后端：probe_servers 补 ip_sort（SCHEMA + 迁移回填 + 4 索引）；`query_servers`
  服务端筛选/排序/分页（conn 五档 CASE 与 ConnBadge 对齐：未测=0/fail=1..3/
  partial=2..3/pass=4）；`server_facets`；退休 list_labels + /servers/labels；
  四条插入路径（create/import/batch/发现导入）全写 ip_sort，update 改 IP 恒重算；
  `_ip_sort_for()`：域名/IPv6 → NULL（null-last）
- 前端：`useServers.ts` hook（跨页勾选 Map<id,ip>、10s 轮询仅 Tab 激活+页面可见、
  隐藏 abort/回前台刷新、300ms 防抖搜索）；服务器库 Tab 接 hook + 分页条；
  退休 filtered/displayList/compareIp/SortKey/connScore
- 审查：两轮独立审查。首轮 2C+2I+6M 全修（C1 跨页勾选被 alive 过滤清空——
  「按当前页裁剪勾选」是错误模式，勾选只能被显式操作移除；C2 域名服务器入库
  崩溃——`_ipv4_sort_key` 对域名抛异常）；复审再抓第四插入路径（发现→导入）
  漏写 ip_sort。**教训：所有 INSERT 路径都要枚举，别只改显眼的两条**
- 上线验证（VPS 2215 台）：分页响应 16.6KB（42 倍缩小）、8-13ms；迁移回填
  2213 行（2 条 IPv6 NULL 属设计）；数值排序正确（1.32.216.28 < 1.32.216.134，
  点分字符串序会排反）；浏览器切 Tab 到数据可见 59ms（30s→59ms）
- 已知非问题：浏览器验证时总数乱跳（485/0）是 IAB 旧缓存 bundle 混合渲染假象，
  破缓存后 2215/45 页正确

## 2. 验证证据（全部已执行）

- 后端：focused（test_database+test_discover+test_probe）**115 passed**；全量 **195 passed**（仅已知 ResourceWarning 与 2 条 FRPC_MULTI_ROLE=all deprecation warnings）。
- 前端：`npx tsc -b && npm run build` exit 0。
- EXPLAIN（temp 库 1000 行、生产同形 SQL）：三分页 plan 分别命中 `idx_probe_discover_time` / `_ip_desc` / `_ip`，无 TEMP B-TREE；EXISTS 用 `sqlite_autoindex_probe_servers_1`；DB 路径在 temp root 内。
- 1000 万有界性：`parse_targets('0.0.0.1-0.152.150.128')` → total=10,000,000、单区间 (1..10,000,000)、TargetPlan 惰性；concurrency 3/7 → queue maxsize 3/7、tasks 4/8；stop() 干净取消。
- 审查：Task 5 两轮独立审查（With fixes → 1 Critical+4 Minor 修复 → 复审 Yes → 1 nit 补齐）；Task 6 独立综合审查七维度 verdict **Yes**。

## 3. 综合审查 Minor 处置

已修（随 final commit）：
1. 迁移回填改为「物化一批 + `id > last_seen_id` 游标」——原流式游标边遍历边改 WHERE 列未定义；**第一版修复在「整批都是无法解析的 legacy 行」时死循环（全量测试挂起被 kill），根因后用 id 游标修复，回归绿**。
2. 扫描错误不再被 final-drain 持久化错误覆盖（首因保留，`; ` 拼接）。

接受为后续迭代（不阻塞）：
- enqueue 背压以阻塞扫描事件循环为代价（有界：writer 批量提交会腾空间；writer 失败立即解阻塞；busy_timeout 5s 兜底）——设计取舍已留档。
- `q` 参数无 max_length；发现表头全选无 indeterminate 态；`thread.start()` 失败会 wedge runner（需 reset）；前端无自动化测试（useDiscovery 竞态逻辑建议引入 vitest）。

## 4. 残余风险（已接受）

- active scan 期间 offset 分页可能移动（后端无游标快照）。
- SQLite 单写者串行化（writer 是唯一写者，首启迁移可能短暂持写锁）。
- 前端 facets 在 route active 期间只在 terminal 刷新，长任务期间标签计数略陈旧。

## 5. 上线记录（2026-08-30 已完成）

1. push origin main（ce52f02..5fe70ff）→ CI `33298725175` 构建发布镜像成功。
2. VPS console：先容器内 sqlite3 backup API 备份 `console-backup-pre-perf.db`，再 compose pull+up -d。
3. agent：docker run 重建（参数不变），重连主控正常。
4. 迁移实测：2179 行 `ip_sort` 回填完成（0 NULL），journal_mode=wal。
5. 线上冒烟全过：results envelope 恰为 {items,page,pageSize,total,sort,order}（无 labels 键）、数值 IP 排序正确、facets 独立（labels/groups/imported/new）、`group=&label=CN2` 显式空串筛选服务端生效（29 行全匹配）、UI 200、路由节点 claim 轮询正常、agent WebSocket 已连。
6. 建议人工过一遍浏览器体验：翻页/筛选/跨页勾选导入/扫描（短 /24）完成后自动刷新。

## 6. 关键文件

| 层 | 文件 |
|---|---|
| DB schema/迁移/连接 | `webui/backend/app/control/database.py` |
| 扫描（TargetPlan/runner/状态） | `webui/backend/app/probe/discover.py` |
| 落库 writer/协调器 | `webui/backend/app/probe/persistence.py` |
| 分页/facets/分块/批量 upsert | `webui/backend/app/probe/store.py` |
| HTTP 契约 | `webui/backend/app/probe/router.py` |
| 前端发现 hook | `webui/frontend/src/pages/probe/useDiscovery.ts` |
| 页面/表格/分页条 | `webui/frontend/src/pages/Probe.tsx` |
| API/类型 | `webui/frontend/src/lib/api.ts`、`lib/types.ts` |
| 测试 | `tests/test_database.py`（新）、`test_discover.py`、`test_probe.py` |
| 过程记录 | `docs/aegis/work/2026-08-30-discovery-performance/`（intent/checkpoint/evidence/99-reflection） |

### 1.2 五项功能追加（be981ef，2026-08-30 已上线）

1. **多标签**：label 存储改逗号哨兵格式 `,a,b,`（迁移 `_migrate_labels_to_multi`，幂等）；
   批量更新 addLabels/removeLabels；路由结论写回剥旧结论保留用户标签；
   facets/筛选/序列化全链路适配；四条 probe_servers 插入路径全部覆盖
2. **订阅扫描**：DiscoverStart.sourceUrl（http/https、15s、2MB），txt 一行一个网段
3. **批量标签弹窗**：已贴标签（labels-preview 聚合 ×count）点击移除、标签云点击添加、
   手动输入；端点 /discover/labels-preview、/servers/labels-preview
4. **连通性判定（确认无误）**：frps_reachable=TCP 通；tunnel_established=frpc 日志
   login+start proxy success（隐含认证通过）；firewall_open=公网 tcping 映射端口。
   非frps/认证失败 → tunnel 失败 → fail 档，与用户理解一致
5. **agent 版本戳**：CI AGENT_VERSION=git 短 sha → Dockerfile ENV → agent 上报
   agentVersion/version；节点列表与系统页改显「Agent 版本」，docker_version 退休

审查要点备忘：迁移函数必须 commit（close 会回滚隐式事务——曾静默失败）；
ADD 标签的 LIKE 去重要带 ESCAPE；INSERT 路径要全部枚举（曾漏「发现→导入」）；
跨页勾选只能被显式操作移除（按当前页裁剪是错误模式）。

## 7. 环境速查

- 本地仓库 main；测试 `cd webui/backend && .venv/bin/python -m unittest discover -s tests -q`（195）；前端 `npx tsc -b && npm run build`。
- VPS 23.19.228.204（netcatty vault: Hostdzire-LAX）；面板凭据查 vault；真实路由节点 debian-work = 10.144.1.3（vault label「ubuntu-work」条目）。
- VPS 发现表 1400+ 真实行；验证时不得污染生产数据。


## 8. 2026-11-18 WebUI 全面易用性与视觉升级归档

- **设计系统与全局壳层**：微调亮/暗双主题表面层级，全站图标库统一收敛至 `lucide-react`（移除 `@hugeicons/*` 冗余依赖）；新增 `PageHeader`、`CopyableText`、层级可点击面包屑、侧边栏实时徽标（异常数 / 活跃测试 / 离线节点 / 异常实例）及全局 `Cmd+K` / `Ctrl+K` 快捷跳转命令面板 `CommandPalette.tsx`。
- **后端协同 API（B1–B6）**：`GET /api/summary` 内联实例配置摘要（消除实例列表前 25 条 N+1 轮询），`GET /api/console-info` 返回 `buildVersion`；新增 `GET /api/workspace/overview` 单请求全域聚合端点；服务器库接口与保存视图支持 `domainStatus=all|assigned|unassigned` 并内联 `domainId` / `domainName`；新增 `POST /api/lb/domains/{id}/check-ports` 单域名业务端口检测、候选池成员附带 `gfwBlocked` / `gfwBlockedPort`；新增 `POST /api/nodes/upgrade-outdated` 批量升级落后在线 Agent。
- **核心页面重塑**：
  - 工作台 `ResourceOverview.tsx` 升级为 6 维全域指标卡 + 进度条化任务卡 + 优选域名速览；
  - 服务器库 `ServersPage.tsx` 紧凑化工具栏、新增域名归属筛选与徽章、单机快捷重测、批量加入域名池及右侧详情抽屉 `ServerDetailSheet.tsx`；
  - 新建测试 `TestCreatePage.tsx` 与新建实例 `CreateInstance.tsx` 重构为一屏双栏卡片布局（实时预览 + 一键提交，支持实例克隆预填）；
  - 候选池 `DomainCandidatesDialog.tsx` 支持分组/标签/未占用筛选、速率排序及候选 GFW 屏蔽一键解封；
  - 配置编辑器 `ConfigEditor.tsx` 支持结构化改绑优选域名与修改前后 Diff 预览；`Detail.tsx` 支持日志语义着色、复制导出及单实例精确审计分页；`NodesPage.tsx` / `AuditLogsPage.tsx` 表格断点优化至 `lg:`；`TestNodesPage.tsx` 新增可视化主备执行链路拓扑条。
- **质量门禁**：后端 `436` 项单测、前端 `39` 项 Vitest 单测、生产构建与 `61` 项 Playwright E2E 全部通过。
