# 2026-11-18 业务端口 GFW 屏蔽检测、主页异常窗口与工程收口 Checkpoint

## 1. 任务范围与核心结论

本轮在 `b75b558` / `199be6d` 基线之上完成了以下 5 个里程碑的完整落地与本地隔离验证（遵循生产零扰动原则，未连接或改动线上 `23.19.228.204:8081` 及真实 Cloudflare DNS）：

1. **优选域名业务端口健康检查 / 大陆 GFW 屏蔽自动切换 + 主页异常监控窗口**：
   - **实例业务端口自动映射**：`config_validator.parse_summary` 新增 `tcpRemotePorts`（仅提取 TCP 代理 `remotePort` 升序去重，过滤 UDP/STCP/XTCP 避免 TCP 握手误报）；Agent `get_summary()` 同步上报配置摘要，Console 在 `lb_instance_ports` 中持久化启用运行中实例的 `(domain/serverAddr -> tcp_remote_ports)` 快照，并对旧版未升级 Agent 自动走 `get_config` 回退拉取与内存 TTL 缓存。
   - **零污染主备节点单点 `tcping`**：新增 `ephemeral_tcping_broker`（`taskId` 前缀 `lb-tcping:`），直接复用现有外部 Worker 的 `/api/probe/worker/claim|heartbeat|progress|report` 轮询通道与 `stage='discover'` 单 IP TCP 探针，既无需升级外部国内测试节点，也不向 `probe_jobs` / `probe_discover_results` 写入任何脏记录，严格守护「正式资产测试端口固定 `7000`」契约。
   - **顺序检测与 GFW 屏蔽/业务端口异常状态机**：对每个启用且存在 `current_ip` 的优选域名，按绑定的运行中实例 TCP `remotePort` 升序逐个检测：
     - **主节点通**：端口正常，继续下一个端口；全部通过则清理该域名残留的 `port_down` 告警。
     - **主节点不通 + 任一有序备用节点（外部备用或最终 `console`）通**：立即短路判定当前 `current_ip` 被大陆 GFW 防火墙屏蔽端口，写入 `lb_gfw_blocks` 隔离表与 `gfw_blocked` 审计告警，并立即调用 `sync_domain` 从候选池选取健康且未被 GFW 屏蔽的候选 IP 切换 DNS（若该 IP 处于手动 `preferred_server_id` 固定态，切换成功后按既有规则自动解除固定；若无可用健康候选则保留现有 DNS 并置 `switched=False` 告警）。
     - **主备节点均不通**：判定为业务端口异常（如后端服务未启动或防火墙未放行），写入/刷新 `lb_port_alerts` 的 `port_down` 告警，**不触发盲目切换 IP**。
     - **观测不确定保护**：当主节点离线/认领超时（`claim_timeout`）时返回 `inconclusive`，绝不误判为 GFW 屏蔽或端口宕机。
   - **防乒乓回切**：`selection_for_domain` 与手动 `switch` 接口均感知 `lb_gfw_blocks` 活跃集合，防止海外 Console 的 `7000` 端口常规健康检查在下一轮将流量切回被墙 IP；支持运维在确认 IP 解封后调用 `DELETE /api/lb/gfw-blocks/{ip}` 手动解除隔离。
   - **主页异常监控窗口与域名选优页联动**：在 `/workspace`（`ResourceOverview.tsx`）新增 `AnomalyWindowCard` 模块，聚合展示业务端口不通、GFW 屏蔽切换/无健康候选告警、离线 Agent、运行失败实例及域名同步错误，支持一键立即检测、解除 IP 屏蔽与忽略告警；`LbPage.tsx` 同步展示候选 GFW 屏蔽徽章与单域名业务端口检测按钮。

2. **服务器库游标分页 `Back/Forward` 状态撕裂修复与 `Probe.tsx` 模块化拆分**：
   - **根因消除**：重构 `webui/frontend/src/pages/probe/useServers.ts`，废除 `useState<ServerQuery>` + `lastObservedUrlRef` 的双向命令式同步，改为以 React Router `useSearchParams` 为单一权威事实来源（Single Source of Truth），根治「点击下一页后快速触发浏览器 `Back` 导致地址栏回退至第 1 页但表格仍停留在第 2 页且不重发请求」的竞态缺陷；同时消除首屏挂载时的双重请求与 `recoverOutOfRange` 中的 `totalCount` 闭包陈旧值。
   - **死代码清理与按需拆分**：移除原 2,101 行 `Probe.tsx` 中不可达的 `history` Tab 死代码及挂载时无条件触发的 200 条连通性/测速历史冗余请求，补齐表头全选 `IndeterminateCheckbox` 半选态，拆分为 `DiscoveryPage.tsx`、`ServersPage.tsx`、`TestsPage.tsx`、`ProbeDialogs.tsx`、`ProbeTableShared.tsx`、`ServerFilterControls.tsx`，并在 `App.tsx` 独立 `lazy` 按需加载。

3. **Console 热备/恢复工具链升级与隔离恢复演练**：
   - 新增 `scripts/backup-console.sh`（SQLite `backup()` 在线一致性热备、`PRAGMA integrity_check`、`0600` 权限与保留轮转）与 `scripts/rehearse-restore.py`（含残留 `-wal`/`-shm` 清理验证的隔离备份恢复全流程演练）。
   - 升级 `scripts/backup-configs.sh` 自动联动热备，升级 `scripts/check-health.sh` 支持 `console` / `agent` 双角色巡检，更新 `docs/OPERATIONS.md`。

4. **目标网络响应分布统计脚本与后端资源告警加固**：
   - 新增只读分析工具 `scripts/analyze_probe_distributions.py`，支持对任意生产备份库或隔离仿真样本统计发现延迟分位数、穿透三阶段转化漏斗、失败原因分类、路由跳数/CN2 占比、上下行速率分位数及主备接替分布，闭环 `2026-10-23-server-library-scale` 遗留待办。
   - 为 `webui/backend/app/probe/router.py` 的 6 个搜索入口参数 `q` 补齐 `Query(max_length=256)` 校验；修复 `probe/bulk.py` 异常分支重复开连接与单测未关闭连接/Socket 的 `ResourceWarning`。

5. **CI 自动化测试门禁**：
   - 新增 `.github/workflows/ci.yml`（后端全量单测 + 恢复演练/分布脚本自检 + 前端 Vitest 单测与生产构建），并在 `.github/workflows/docker-publish.yml` 增加前置 `verify` 门禁，测试未过禁止推送多架构镜像。

## 2. 检查点清单

- [x] `config_validator.py` 与 Agent `service.py` 提取并上报 `tcpRemotePorts`，兼容旧 Agent 回退读取配置
- [x] `database.py` 新增 `lb_instance_ports`、`lb_gfw_blocks`、`lb_port_alerts` 三张表与索引（幂等迁移）
- [x] `ephemeral_tcping.py` + `jobs.py` 实现零持久化污染的外部主/备节点与本地 `console` 单点 `tcping`
- [x] `port_health.py`、`selection.py`、`syncer.py`、`scheduler.py`、`lb/router.py` 完成顺序端口检测、GFW 屏蔽自动切换、业务端口异常告警与 API 暴露
- [x] `ResourceOverview.tsx` 新增主页异常监控窗口，`LbPage.tsx` 集成端口检测与屏蔽状态展示
- [x] `useServers.ts` 重构为 URL 单一权威状态源并补充回归测试，修复游标 `Back/Forward` 撕裂
- [x] `Probe.tsx` 拆分为按路由懒加载的独立页面子模块，清理冗余请求并补齐 `indeterminate` 全选态
- [x] 交付 `backup-console.sh`、`rehearse-restore.py`、`analyze_probe_distributions.py` 及 `check-health.sh` 升级，产出隔离演练与分布报告
- [x] 清理 `bulk.py` 与测试套件连接泄漏，补齐 `q` 参数 `max_length=256` 校验
- [x] 配置 `.github/workflows/ci.yml` 与 `docker-publish.yml` 前置验证门禁
