# 服务器库性能优化 · 会话交接记忆（2026-08-29）

> 新会话从这份文档继续。前置背景：`chat/PROJECT_MEMO_2026-08-22.md`、`chat/ROUTE_TEST_HANDOFF_2026-08-23.md`（本地文档，含敏感凭据，未入库）。
> 本文档是首个进 GitHub 的交接文档；凭据一律引用 netcatty vault，不写明文。

## 0. 当前状态一句话

CN2 路由追踪全链路已上线验证完毕；回环 localIP 修复已上线；**当前任务：服务器库（网段发现）大数据量性能优化——调查已完成、根因全部定位，下一步写正式优化方案并实施**。

## 1. 本会话已完成事项（均已上线，无需重做）

| 事项 | Commit | 说明 |
|---|---|---|
| mtr 解析 bug | `96b9712` | mtr `--json` 跳数组键名是 `hubs` 非 `hops`，读错导致全部误判「非 CN2（0 跳）」。修复：hubs 优先、hops 兜底、0 跳按失败回报。已部署 debian-work 并重测 5 条误判行，全部正确判定 CN2（12~16 跳） |
| 回环 localIP 穿透 | `a020175` | frpc 实例容器内 127.0.0.1 回环到容器自身。写入侧唯一收口 `instance_store`（create/update）自动把回环 localIP（127.0.0.1/localhost/::1）改写为 `host.docker.internal`（compose 已注入 host-gateway extra_hosts）。138 测试全过；VPS console+agent 已更新。**存量配置不追溯，重新保存一次即生效** |
| 路由追踪收尾 | 上会话 `1aed790` | stub 联调 ALL OK（400 实为节点重名）；面板三色标签/弹窗/操作条验证全过 |

注意事项（踩过的坑）：
- mtr JSON 键名：`report.hubs`（不是 hops）
- debian-work = 10.144.1.3（vault 里 label 是「ubuntu-work」的那条；vault 里叫「debian-work」的 192.168.1.135 不在当前网络）
- VPS agent 是 `docker run` 手工容器（无 compose 管理），重建命令见 `chat/ROUTE_TEST_HANDOFF_2026-08-23.md` 或 `docker inspect frpc-agent`
- 联调脚本必须打印 HTTP 错误响应 body + 幂等可重跑

## 2. 性能问题调查结论（用户反馈 → 根因，行号级）

用户反馈：① 网段发现「只能导入小于 26 万个数据」；② 不到 1 万条数据，切换 Tab 就很卡。

### 2.1 「26 万」的真相

- **`webui/backend/app/probe/discover.py:22` `MAX_TARGET_IPS = 262_144`**——是**扫描目标 IP 数**上限（不是结果条数），`parse_targets()`（discover.py:104-114）超限抛 ValueError → router 转 400。一个 /8 或 5 个 /16 就触发。
- 同文件 discover.py:192 `await asyncio.gather(*(probe(ip) for ip in ips))` 一次性创建全部目标 task（26 万个 coroutine，内存尖峰）；parse_targets 把 CIDR 全展开成 int set + str list（104-114）。
- 落库逐条：每命中 `store.upsert_discover_result()`（store.py:334-347）**新建 sqlite 连接 → 每次重跑整套 SCHEMA（database.py:197-207）→ 单行 INSERT → commit fsync（无 WAL）**；autoRoute 时每命中再多一次 `discover_row_needs_route()` 连接。

### 2.2 「1 万条就卡」主因链（按影响排序）

1. **后端全量返回**：`GET /discover/results`（router.py:582-595 → store.py:392-407）无分页无 LIMIT，`LEFT JOIN probe_servers` + `ORDER BY discovered_at DESC, d.ip`，而 **discovered_at 无索引** → 全表 filesort；响应还附 `list_labels()`（store.py:315-330，UNION 全表 GROUP BY，label 列无索引）。
2. **前端全量渲染**：`Probe.tsx:643` `discoverFiltered.map(...)` 一次渲染全部行（每行 checkbox + 2-3 Badge + Button + svg + 相对时间计算）；无分页、无虚拟滚动（package.json 无 react-window/@tanstack/*）。1 万行 ≈ 8-10 万 DOM 节点。
3. **切 Tab 卡的直接来源**：Radix Tabs 封装（tabs.tsx:83-94）无 forceMount → 切换即整表卸载重挂；且四个 Tab 的 JSX 都在 `Probe` render 体内即时求值（643/780/967/995 行），任何 re-render 全部重建。
4. **轮询风暴**：10s 服务器（Probe.tsx:204）、1.2s/6s 测试状态（261-280）、扫描中 1.5s（**209-219 每 tick 调了两次 loadDiscover**）、路由队列 2s（225-232）；全部与 Tab 可见性无关；每次新数组引用 → `discoverFiltered`（306-324）全量 filter+sort（compareIp 80-91 每次比较 split/map，很重）→ 全表 reconcile。
5. **批量操作硬伤**：`update_discover_batch`（store.py:421）、`delete_discover_results`（435）、`update_servers_batch`（458）`IN (?,...)` 逐 id 占位符，**>32766 触发 SQLite 变量上限 → 全选批删/批改直接 500**；前端也不分批。
6. **discover_import 全表加载**（router.py:619-639）：导入前 `list_discover_results()` 把整表读进内存建 dict。
7. **status 接口膨胀**：discover.py:212 `status()` 全量返回 `found` 数组；前端扫描中每 1.5s 拉，随命中数线性膨胀。

## 3. 优化方案骨架（新会话按此细化成正式方案再实施）

### A. 后端数据层（收益最大，先做）

1. **连接与 PRAGMA**：`connect_database` 不再每次重跑 SCHEMA——模块级单连接（`check_same_thread=False` + 锁）或 threading.local；`journal_mode=WAL` + `synchronous=NORMAL`。所有 API 固定开销消失，扫描落库快 10-100 倍。
2. **分页 API**：`/discover/results` 加 `limit/offset`（或游标）+ 服务端筛选/排序/搜索参数；`discovered_at`、`label`、`server_group` 建索引；`list_labels` 缓存或独立接口。
3. **批量操作分块**：IN 子句按 ~500/块拆分（或临时表 join），delete/update_batch/import 全覆盖——顺便修掉 3.3 万批删必崩。
4. **扫描落库批量化**：on_hit 进内存队列，每 0.5s 或 100 条批量 executemany 单事务。
5. **status 减负**：`found` 改为计数 + 最近 N 条（或分页拉取）。
6. **扫描目标惰性化**：parse_targets 不再展开 int set（迭代器 + 去重用整型网络计算）；`MAX_TARGET_IPS` 是否上调（如 100 万）待用户确认。
7. **import 去全表加载**：按 ids 直接 `SELECT ... WHERE id IN (...)`（分块）。

### B. 前端渲染层

1. **服务端分页表格**（推荐，配合 A2）：发现表后端分页，前端只渲染当前页（~100 行）；排序/搜索/筛选参数传后端。备选：@tanstack/react-virtual 虚拟滚动（不动 API，但筛选仍在前端全量算）。
2. **Tab 懒渲染**：各 Tab 内容抽子组件 + React.memo，仅 active Tab 渲染（或 Radix forceMount + display 控制）；轮询 setState 前做浅比较，数据没变不触发。
3. **轮询治理**：修掉 209-219 双重 loadDiscover；轮询与 Tab 可见性联动；发现表分页后轮询只刷当前页与计数。
4. **compareIp 预解析**：排序前 IP 预转数值键缓存（若保留前端排序）。

### C. 实施顺序与验证

1. A1（连接/WAL）→ A3+A7（分块，修批删崩溃）→ A2+B1（分页+索引）→ A4+A5+A6（扫描）→ B2+B3（Tab/轮询）。
2. 压测：本地库灌 10 万行假数据（脚本直插 SQLite），验证各接口耗时与前端流畅度；后端 138 测试全过 + `npx tsc -b && npm run build`。
3. 测试基线：`cd webui/backend && .venv/bin/python -m unittest discover -s tests -q`（当前 138 个）。

### 待用户确认

- 扫描目标上限 26 万是否需要上调（现状是误输入保护，提高到多少？）
- 前端选**服务端分页**（推荐）还是虚拟滚动？

## 4. 环境速查

- **本地仓库**：`/Users/zm/Documents/frpc-multi`（main，最新 `a020175` 已推送 GitHub；chat/ 仅本文档入库）
- **VPS**：23.19.228.204:35477 root（netcatty vault: Hostdzire-LAX，hostId `6e4df6ed-2e2a-45c8-a1b7-2bb4d76e8770`）；面板 http://23.19.228.204:8081（凭据见 vault / 旧交接文档）
- console 部署：`cd /opt/frpc-multi && docker compose -f compose.console.yaml pull -q && docker compose -f compose.console.yaml up -d`；agent 重建命令见 ROUTE_TEST_HANDOFF
- **真实路由节点**：debian-work（10.144.1.3，vault hostId `9e12904f-e391-41e1-b0e5-a7e41a7e237c`），`/opt/frpc-route/` + systemd `frpc-route`
- **VPS 数据**：发现表 1400+ 条真实记录，联调只动自造数据
- 测试：`cd webui/backend && .venv/bin/python -m unittest discover -s tests -q`；前端 `npx tsc -b && npm run build`
