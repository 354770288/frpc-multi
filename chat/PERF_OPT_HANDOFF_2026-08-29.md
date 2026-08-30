# 服务器库性能优化 · 交接记忆（2026-08-30 完成）

> 状态：**专项完成**。Task 1–6 全部实现、审查、验证并提交。本文档是唯一进 GitHub 的交接文档；凭据一律查 netcatty vault，不写明文。

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
<final> docs: Task 6 证据与收尾（含 Minor#1/#2 修复）
```

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

## 7. 环境速查

- 本地仓库 main；测试 `cd webui/backend && .venv/bin/python -m unittest discover -s tests -q`（195）；前端 `npx tsc -b && npm run build`。
- VPS 23.19.228.204（netcatty vault: Hostdzire-LAX）；面板凭据查 vault；真实路由节点 debian-work = 10.144.1.3（vault label「ubuntu-work」条目）。
- VPS 发现表 1400+ 真实行；验证时不得污染生产数据。
