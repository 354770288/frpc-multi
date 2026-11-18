# 2026-11-18 全量验证与交付证据（90-evidence）

## 1. 验证总览

| 验证维度 | 执行命令 | 结果 | 关键数字 / 备注 |
| --- | --- | --- | --- |
| 后端全量单元测试 | `cd webui/backend && ../../.venv/bin/python -m unittest discover -s tests` | `PASS` | **434 项全部通过**（76.88s，较基线 424 项新增 10 项业务端口 GFW 判定、参数校验与运维脚本单测） |
| 后端 SQLite 资源严格校验 | `cd webui/backend && ../../.venv/bin/python -W error::ResourceWarning -m unittest tests/test_probe_bulk.py tests/test_probe_import_api.py tests/test_probe_selection_jobs.py` | `PASS` | **41 项 0 告警通过**（消除 `sqlite3.Connection` 未 `close()` 的泄漏） |
| 前端 Vitest 单元测试 | `cd webui/frontend && npm test` | `PASS` | **13 个文件、37 项全部通过**（398ms，新增 `lbDomainView` GFW 投影、`ResourceOverview` 异常窗口、`useServers` 游标单测） |
| 前端生产构建 | `cd webui/frontend && npm run build` | `PASS` | `tsc && vite build` 零错误；`TestsPage` 16.79 kB、`DiscoveryPage` 20.75 kB、`ServersPage` 61.38 kB 独立按需加载 |
| 前端 Playwright 浏览器全套 E2E | `cd webui/frontend && npx playwright test` | `PASS` | **60 项全部通过**（32.1s，含新增 `workspace-anomalies.spec.ts` 与增强后的游标 `Back/Forward` 新请求断言） |
| Console 备份恢复隔离演练 | `./.venv/bin/python scripts/rehearse-restore.py --self-test` | `PASS` | 报告见 [restore-rehearsal.md](restore-rehearsal.md) 与 [restore-rehearsal.json](restore-rehearsal.json) |
| 目标网络响应分布只读统计 | `./.venv/bin/python scripts/analyze_probe_distributions.py --self-test` | `PASS` | 报告见 [response-distributions.md](response-distributions.md) 与 [response-distributions.json](response-distributions.json) |
| GitHub Actions Workflow 语法 | `./.venv/bin/python -c "import yaml..."` | `PASS` | `.github/workflows/ci.yml` 与 `.github/workflows/docker-publish.yml` 解析通过 |

## 2. 新功能与缺陷修复验证明细

### 2.1 优选域名业务端口健康检查 / GFW 屏蔽切换 + 主页异常窗口

- **后端单元测试**（`webui/backend/tests/test_lb_port_health.py` 与 `test_core.py`）：
  - 验证 `parse_summary` 正确区分 TCP `remotePorts`（`tcpRemotePorts`）与 UDP/STCP/XTCP 代理，不因非 TCP 协议触发假阳性握手失败；
  - 验证 `InstancePortRegistry.refresh` 同时支持新版 Agent `get_summary()` 内嵌摘要与旧版 Agent `get_config` 回退拉取；
  - 验证 `ephemeral_tcping_broker` 通过 `lb-tcping:` 任务通道被外部 Worker `claim` -> `heartbeat` -> `report` 闭环处理，且 `probe_jobs` / `probe_discover_results` 行数保持为 `0`；
  - 验证业务端口按升序检测状态机：
    1. 主节点与备用节点均通 -> 无屏蔽、清理历史 `port_down` 告警；
    2. 任一业务端口主节点不通 + 备用节点（外部备用或 `console`）通 -> 立即写入 `lb_gfw_blocks`、`gfw_blocked` 告警，并自动调用 `sync_domain` 切换至候选池其他健康 IP（若原目标处于手动 `preferred_server_id` 固定态，切换成功后自动解除固定）；
    3. 所有健康候选均已被 GFW 屏蔽时 -> 保留现有 DNS 记录不清空，生成 `switched=False` 告警；
    4. 主节点与所有备用节点均不通 -> 记录 `port_down` 业务端口异常，**不触发 IP 切换**；
    5. 主节点离线或认领超时（`claim_timeout`） -> 返回 `inconclusive`，不误判屏蔽或端口宕机；
  - 验证 `DELETE /api/lb/gfw-blocks/{ip}` 解除屏蔽与 `POST /api/lb/port-alerts/{alert_id}/dismiss` 忽略告警 API。
- **前端与浏览器验证**（`ResourceOverview.test.tsx`、`lbDomainView.test.ts`、`e2e/workspace-anomalies.spec.ts`）：
  - 验证工作台主页 `/workspace` 异常监控窗口准确聚合展示「业务端口不通」「GFW 屏蔽已自动切换 / 无可用候选」「部署节点离线」「实例运行失败」「DNS 同步失败」；
  - 真实浏览器点击「解除 IP 屏蔽」「忽略」「立即检测端口」均发起正确 API 请求并实时刷新视图。

### 2.2 服务器库游标 `Back/Forward` 修复与 `Probe.tsx` 模块化拆分

- **根因闭环**：
  - 移除旧版 `useServers.ts` 中 `useState<ServerQuery>` 与 `lastObservedUrlRef` 的双向同步分裂逻辑；
  - 改为以 `useSearchParams` 为权威源，配合 `latestUrlKeyRef` 同帧队列串联乐观投影与 `popstate` 即时释放，同时用 `setUrlRef` / `refreshAllRef` 避免 URL 规范化 `replace` 触发 `useEffect` cleanup 误中止在途 `facets` / `count` 请求。
- **浏览器实测证据**：
  - `e2e/test-creation.spec.ts` 中 `server cursor restores browser back and forward URLs` 在加强断言（明确校验 `page.goBack()` 后新增一条不含 `cursor` 参数的 `/api/probe/servers/cursor` 请求并渲染第 1 页行数据，再 `page.goForward()` 新增一条 `cursor=cursor-page2` 请求并渲染第 2 页行数据）后稳定通过；
  - 全套 **60 项 Playwright 测试**（覆盖高级分组/标签多选、标签分页搜索、冻结快照、保存视图、批量任务、候选池排他同步、主页异常窗口）一次性全部通过。

## 3. 线上生产部署与首轮巡检实测证据（2026-11-18）

- **CI 与镜像发布**：
  - [CI Run 44213247647](https://github.com/354770288/frpc-multi/actions/runs/44213247647) 与 [Publish Run 44213247581](https://github.com/354770288/frpc-multi/actions/runs/44213247581) 均成功完成，多架构镜像 `ghcr.io/354770288/frpc-multi:latest`（Digest `sha256:fc25a81364d7adfe41135e093bbd003d21f7e437975b6871ad9098682aad4b23`，内嵌 `AGENT_VERSION=e8081e3`）发布就位。
- **停机前备份、回滚保留与禁网预检**：
  - 升级前确认 `probe_jobs` 无 `queued`/`running` 活跃任务。
  - 在线热备 `/data/console-before-e8081e3-20261118.db`（大小 `49,917,952` 字节，权限 `0600`，`PRAGMA integrity_check=ok`），`.env` 备份为 `.env.before-e8081e3-20261118`。
  - 原运行镜像 `frpc-multi:fixes-b75b558` 额外保留回滚标签 `frpc-multi:rollback-before-e8081e3`；停止态禁网预检容器 `frpc-e8081e3-preflight-20261118` 验证新表与既有 2,319 台资产、3,179 条测试历史、35,939 条发现记录及 4 个域名候选完整性通过。
- **切换与接口验收**：
  - `frpc-console` 切换至 `frpc-multi:release-e8081e3`（同时同步 `.env` 的 `CONSOLE_IMAGE`），容器 `status=running`、`restarts=0`；外网首页 `http://23.19.228.204:8081/` 返回 HTTP `200`，静态产物包含 `DiscoveryPage-*.js`、`ServersPage-*.js`、`TestsPage-*.js`、`ResourceOverview-*.js`。
  - 4 台部署节点（`onlineCount=4`）与外部国内主测试节点（`深圳电信-ubuntu-work`）全部在线；数据库 `PRAGMA integrity_check=ok`，`probe_discover_results` 行数保持 `35,939`（单点 `tcping` 零污染）。
- **上线首轮业务端口健康巡检真实命中与自愈结果**：
  1. `us1.zmfrp.eu.org`（`23.106.156.186`，自动识别端口 `10894, 13340, 13341, 13342`）：主节点顺序 `tcping` 4 个端口全通 → `healthy`；
  2. `hk1.zmfrp.eu.org`（原 `191.222.219.63`，自动识别端口 `1255, 1256`，实例 `Hytron-HK/client-005`）：主节点 `深圳电信-ubuntu-work` 探测 `1255` 不通，备用节点 `Console` 探测 `151.3ms` 连通 → 精准判定 `gfw_blocked`，自动隔离 `191.222.219.63` 并成功将 Cloudflare A 记录切换至健康候选 `1.32.216.28`；
  3. `eu1.zmfrp.eu.org`（`38.59.224.216`，自动识别端口 `2235`，实例 `h2.nexus/client-006`）：主节点与备用节点均连接超时 → 精准判定 `port_unreachable`（业务端口异常，未盲目切换 IP），已在主页异常监控窗口告警；
  4. `cnix.isp0.de`（`14.18.252.169`）：当前无运行中绑定实例端口 → `no_business_ports`。

