> ⚠️ **历史文档（已被取代）**：本评审针对旧的 "Console 主动 HTTP 连 Agent + all 模式" 架构做的差距诊断。
> 其中多数缺口（all 模式 `/agent/*` 暴露、HTTP 转发、token 存储等）已随 2026-05 的**反转连接模型**重构而消失或改变。
> 最新架构见根目录 `README.md`、`docs/AGENT_INSTALL.md`、`docs/MIGRATION.md`。本文仅作历史记录保留。

# Console + Agent 现状差距诊断与收尾计划

> 评审日期：2026-05-30
> 评审方式：逐行核对后端 `app/agent/`、`app/control/`、`main.py`、`settings.py`、`tests/test_core.py`，前端 `lib/api.ts`、`lib/types.ts`、`pages/Detail.tsx` 等，三套 compose 与 `.env.example`，并与 `docs/CONSOLE_AGENT_PLAN.md`、`docs/IMPLEMENTATION_CHECKLIST.md` 对照。
> 一句话结论：**主干确实已完成且测试扎实；缺口集中在"计划列了但没建的几个功能 + 审计/安全的两处硬伤"，不是已有代码有 bug。**

---

## 1. 已经做实的部分（先肯定）

这些不是自评，是核对代码后确认的：

- 后端角色边界清晰：`app/agent/`（本机执行 service + router + token 鉴权）与 `app/control/`（节点存储 / AgentClient / 审计 / 主控路由）真实拆开；`main.py` 按 `FRPC_MULTI_ROLE` 装配，`all/console/agent` 三态有路由级单测断言（`test_*_role_mounts_*`）。
- 节点实例转发**全集**已实现并有顺序断言：list / create / get / patch / delete / config(get,put) / validate / logs / start / stop / restart / recreate（`test_node_instance_api_forwards_to_agent_client`）。
- `AgentClient` 错误分类完整：401 / 404 / 5xx / 超时 / 连接失败，均有单测。
- 多节点 `/api/summary` 聚合 + 单节点离线容忍（不拖垮整体），有单测。
- 节点 token 不回显前端（`_public_node` 不含 token），有单测。
- 容器实例 follow 日志在节点场景下被**主动禁用并给出 UI 提示**——属于诚实降级，不是漏写。

---

## 2. 差距清单（按优先级）

### P1-A　远程节点无实时日志流（SSE 转发缺失）

- 现象：Agent 侧有 `GET /agent/instances/{name}/logs/stream`（`agent/router.py:130`），本机 `/api/instances/{name}/logs/stream` 也有（`main.py:266`）；但 **Console 转发层没有** `/api/nodes/{node_id}/instances/{name}/logs/stream`，`AgentClient` 也没有 `stream_logs`（`agent_client.py` 仅 `logs`）。
- 前端佐证：`Detail.tsx:75` 对 `nodeId > 0` 直接 `return` 不建 EventSource，`:187` 显示"节点实例暂不支持实时跟随"，`:225` 禁用开关。
- 影响：远程节点只能静态拉日志，排障体验明显弱于本机。计划 §11.3 把它列为"增强能力"主动延后——属于明确的未完成项。

### P1-B　审计只记成功，不记失败

- 现象：`control/router.py:78` 的 `_audit_instance_action` 与 `main.py:109` 的 `record_local_instance_action` 都**硬编码 `success=True`**，且只在操作成功后调用；操作抛错时先 raise，根本不写审计。`audit_logs.success` 列永远是 True。
- 影响：对"审计"这个卖点是硬伤——失败的高危操作（对离线节点删除、start 失败、token 失效）不留任何痕迹。安全审计恰恰最需要失败/被拒记录。

### P1-C　`all` 模式 `/agent/*` 默认无鉴权

- 现象：`agent/auth.py:17` 在 `agent_auth_enabled=false` 时直接放行；`.env.example` 默认 `AGENT_AUTH_ENABLED=false`；而 `all` 模式 `include_agent_api=True`（`settings.py:62`）会挂载 `/agent/*`。
- 影响：默认 all 模式绑定 `127.0.0.1` 时仅本机可达，尚可；但一旦把 WebUI 改 `0.0.0.0` 或反代出去且没开 agent 鉴权，`/agent/*` 这套 **Docker 控制面就裸奔了**，绕过保护 `/api/*` 的登录。SECURITY.md 只讲了"分离部署 agent 要开鉴权"，没点明 all 模式这个绕过点。

### P2-D　节点系统信息不可达

- 现象：计划 §5.1 列了 `GET /api/nodes/{node_id}/system`，`AgentClient.get_system()` 也已封装，但 control 路由**没暴露这个端点**；`SystemPage.tsx` 无任何节点引用，是纯本机视图。
- 影响：无法在 Console 里查看远程节点的 Docker 版本 / frp 镜像 / 磁盘，计划 §6 的"按节点查看系统信息"没落地。

### P2-E　缺一主一 Agent 的连贯迁移/上手文档

- 现象：README 有零散片段，但没有一份"从单机 all 迁移到 Console + 远程 Agent"的连贯 walkthrough（计划阶段 6 的验收项）。
- 影响：新用户从单机走向分离部署时缺手把手路径。

### P3-F　CORS origins 写死

- 现象：`main.py:32` 固定 `127.0.0.1:8081` / `localhost:8081` + `allow_credentials=True`。
- 影响：当前前端同源托管**无感**；仅当通过域名/反代访问、或将来真做前端独立部署时才会被浏览器跨域拦截。优先级低，但应改成可配置（环境变量）。

### P3-G　节点 token 明文存 SQLite（纵深防御）

- 现象：`node_store.py` 明文存 `nodes.token`（计划 §3.1 设想的是 `token_secret_ref`）。已不回显前端，风险有限。
- 影响：DB 文件泄露即 token 泄露。属加固项，非紧急。

---

## 3. 收尾计划（分批，每批可独立交付）

### 批次 1：审计失败路径 + all 模式安全（P1-B / P1-C）

纯后端、风险低、价值高，先做。

- 审计：把"操作成功后写 success=True"改为"成功写 True、异常写 False + 错误消息"。建议在 `control/router.py` 抽一个 `try/except` 包装或装饰器，本机路径（`main.py`）同改。
- 安全：`all` 模式下，要么默认要求 agent 鉴权、要么不挂 `/agent/*`；至少在 `.env.example` 加注释、SECURITY.md 增"all 模式暴露风险"小节。
- 验收：`cd webui/backend && python -m unittest`；新增审计失败用例、all 模式 `/agent/*` 未授权应 401 的用例。

### 批次 2：节点实时日志流（P1-A）

- `AgentClient` 增 `stream_logs`（透传 SSE 字节流，带 token、超时放宽）。
- control 路由增 `GET /api/nodes/{node_id}/instances/{name}/logs/stream`，用 `StreamingResponse` 透传，并按 `require_auth_query` 支持 EventSource 的 query token。
- 前端 `Detail.tsx` 放开 `nodeId > 0` 的 follow 分支，走节点流地址；保留断流/超时降级。
- 验收：后端透传单测（mock agent SSE）；前端 `npm run build`；手工验证远程节点 follow。

### 批次 3：节点系统信息（P2-D）

- control 路由增 `GET /api/nodes/{node_id}/system` → `AgentClient.get_system`。
- 前端 `SystemPage` 拆"主控系统信息 / 各节点系统信息"，节点离线显示不可达。
- 验收：转发单测；`npm run build`。

### 批次 4：文档与配置（P2-E / P3-F / P3-G）

- 写 `docs/MIGRATION.md`：单机 all → Console + 远程 Agent 的完整步骤 + 新增节点步骤。
- CORS origins 改环境变量（如 `WEBUI_CORS_ORIGINS`），默认保持现值。
- （可选）节点 token 落库前做对称加密或迁移到独立密钥引用。

---

## 4. 测试补全清单（对应上面缺口）

- SSE 日志流透传（本机已有逻辑但无测试；节点透传待建后补测）。
- 审计 `success=False` 路径（操作失败也要落审计）。
- `all` 模式 `/agent/*` 未授权访问应 401。
- 节点 ping 失败置 `offline` 的断言（现仅测了 ping 成功置 online）。
- `/api/nodes/{node_id}/system` 转发（端点建成后）。

---

## 5. 非问题澄清（避免误伤）

- 节点 follow 禁用 + "暂不支持"提示是有意降级，不是 bug。
- `compose.console.yaml` 不挂 docker socket / 不挂项目目录，边界干净，符合设计。
- 测试套件对**已实现**功能覆盖扎实，本次不需要"补测已有代码"，而是"先建功能再补对应测试"。

## 6. 收尾进度（2026-05-30 实现）

四个批次已实现并完成静态校验（后端 `py_compile` 全过、前端 `tsc --noEmit` 退出 0、settings 角色门控与 CORS 在本地实跑验证）。后端单测因当前环境无法联网装依赖未在此执行，需在本机 venv 跑 `cd webui/backend && python -m unittest`。

- [x] **P1-B 审计失败路径**：`control/router.py` 与 `main.py` 引入 `_run_node_instance_action` / `run_local_instance_action` 包装器，成功与失败都落审计（失败写 `success=False` + 错误消息）。新增本机/节点两条失败审计单测。
- [x] **P1-C all 模式 `/agent/*` 安全**：`settings.include_agent_api` 改为 all 模式仅在 `agent_api_secured`（鉴权开启且有 token）时挂载；agent 角色未鉴权时启动告警。新增 `SettingsTests` + 路由级断言；更新 `.env.example`、`docs/SECURITY.md`。
- [x] **P1-A 节点实时日志流**：`AgentClient.stream_logs`（SSE 透传 + 失败合成 error/end 帧）、`GET /api/nodes/{id}/instances/{name}/logs/stream`（`require_auth_query`）、前端 `Detail.tsx` 放开节点 follow。新增 3 条 stream 单测。
- [x] **P2-D 节点系统信息**：`GET /api/nodes/{id}/system`、前端 SystemPage 增"节点系统信息"区（离线显示不可达）。新增转发单测。
- [x] **P2-E 迁移文档**：新增 `docs/MIGRATION.md`，README 链接。
- [x] **P3-F CORS 可配置**：`WEBUI_CORS_ORIGINS` 环境变量，默认沿用本机来源。
- [~] **P3-G 节点 token 加密**：未实现落库加密（避免半成品加密）；改为在 `docs/SECURITY.md` 文档化保护措施（卷权限、不外发、轮换）。

