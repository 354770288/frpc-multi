> ⚠️ **历史文档（已被取代）**：本清单基于旧的 "Console 主动 HTTP 连 Agent + all 单机模式 + AGENT_TOKEN bearer" 架构。
> 项目已于 2026-05 改为**反转连接模型**（Agent 出站连回 Console、取消 all 模式、uuid+secret 一键安装）。
> 最新架构见根目录 `README.md` 与 `docs/AGENT_INSTALL.md`。本文仅作历史记录保留。

# Console + Agent 实施清单

## 当前实际状态

截至当前代码，Console + Agent 主干能力已经进入收尾阶段：

- 单机兼容模式仍由 `compose.yaml` 和默认 `FRPC_MULTI_ROLE=all` 承担；没有配置节点时，前端创建实例默认走“本机”兼容路径。
- Console 分离模式由 `compose.console.yaml` 承担，只挂载前端和 `/api/*`，不挂载 Docker socket。
- Agent 分离模式由 `compose.agent.yaml` 承担，只挂载 `/agent/*`，默认启用 `AGENT_AUTH_ENABLED=true`，并要求配置 `AGENT_TOKEN`。
- Console 已支持节点 CRUD、节点 ping、远程 Agent 转发、多节点 summary 聚合和审计日志。
- 前端已加入节点页、节点选择、`nodeId + instanceName` 实例操作，以及无节点时的本机兼容创建。

## 历史起点结论

应从 **阶段 1：角色边界整理** 开始。

不要先做前端多节点页面，也不要先引入完整 SQLite 主控库。原因是当前系统的核心耦合在后端：`main.py` 同时承担路由、实例文件管理、Compose 生成、Docker 命令执行和静态前端托管。只有先把“本机执行能力”整理成 Agent 边界，后续 Console 才能用同一套能力去调用本机 Agent 或远程 Agent。

第一阶段目标不是立刻变成多服务器，而是做到：

```text
现有单机功能不变
  +
后端内部已经有 Agent API / Agent service 边界
  +
后续可以把 Console API 改成调用 Agent
```

## 总体执行顺序

```text
1. 后端角色边界整理
2. Agent API 成型
3. Console 本地兼容层
4. SQLite 节点管理
5. Console 调用远程 Agent
6. 前端加入节点维度
7. 多节点聚合与审计
8. 部署文件和迁移文档
```

## 里程碑 1：整理后端执行边界

目标：不改变当前前端和 API 行为，把本机实例管理能力从 `main.py` 中拆出来。

### 任务 1.1：建立 Agent 模块目录

新增文件：

```text
webui/backend/app/agent/__init__.py
webui/backend/app/agent/service.py
webui/backend/app/agent/router.py
webui/backend/app/agent/auth.py
```

调整目标：

- `service.py` 负责本机实例业务。
- `router.py` 暴露 `/agent/*` API。
- `auth.py` 负责 Agent token 鉴权。

验收：

```bash
cd webui/backend
python -m unittest
```

### 任务 1.2：抽出 LocalAgentService

新增 `LocalAgentService`，封装当前本机能力：

```text
list_instances
create_instance
get_instance
delete_instance
patch_instance
get_config
update_config
validate_config
get_logs
stream_logs_args
start_instance
stop_instance
restart_instance
recreate_instance
get_stats
get_summary
get_system
regenerate_compose
```

涉及文件：

```text
webui/backend/app/agent/service.py
webui/backend/app/main.py
webui/backend/app/instance_store.py
webui/backend/app/docker_service.py
webui/backend/app/compose_generator.py
```

要求：

- 先移动业务编排，不改底层 `InstanceStore`、`DockerService` 行为。
- 当前 `/api/*` 路由仍能工作。
- 先不要引入远程 Agent。

验收：

```bash
cd webui/backend
python -m unittest
```

### 任务 1.3：新增 Agent API

新增 `/agent/*` 路由，初期和当前 `/api/*` 能力基本等价。

最小接口：

```text
GET  /agent/health
GET  /agent/system
GET  /agent/instances
POST /agent/instances
GET  /agent/instances/{name}
GET  /agent/instances/{name}/config
PUT  /agent/instances/{name}/config
POST /agent/instances/{name}/start
POST /agent/instances/{name}/stop
POST /agent/instances/{name}/restart
GET  /agent/summary
GET  /agent/stats
```

涉及文件：

```text
webui/backend/app/agent/router.py
webui/backend/app/main.py
webui/backend/tests/test_core.py
```

验收：

- 原 `/api/*` 功能不变。
- 新 `/agent/health` 可返回 `{"ok": true}`。
- 新 `/agent/instances` 能列出本机实例。

### 任务 1.4：Agent token 鉴权框架

状态：已完成。后端测试已覆盖 Agent token 正确、缺失、错误三种访问结果，并确认 `/api/*` 用户登录鉴权不受 Agent token 配置影响。

新增环境变量：

```text
AGENT_TOKEN
AGENT_AUTH_ENABLED
```

建议规则：

- `AGENT_AUTH_ENABLED=true` 时，`/agent/*` 必须校验 `Authorization: Bearer <token>`。
- 开发模式或未配置时，可以临时关闭 Agent 鉴权，但生产文档必须要求开启。

涉及文件：

```text
webui/backend/app/settings.py
webui/backend/app/agent/auth.py
webui/backend/app/agent/router.py
```

验收：

- token 正确时可访问。
- token 缺失或错误时返回 401。
- `/api/*` 用户登录鉴权不受影响。

## 里程碑 2：Console 兼容层

目标：让当前 `/api/*` 不再直接操作文件和 Docker，而是通过本机 Agent service 完成。

### 任务 2.1：瘦身 main.py

把 `main.py` 中的实例业务逻辑迁移出去。

保留：

- FastAPI app 创建。
- CORS。
- 用户登录。
- router 注册。
- 静态文件挂载。

移出：

- 直接创建 `InstanceStore`。
- 直接创建 `DockerService`。
- 直接调用 `write_generated_compose`。
- 直接拼 Docker 日志流命令。

验收：

```bash
cd webui/backend
python -m unittest
```

### 任务 2.2：增加角色配置

状态：已完成。`all`、`console`、`agent` 三种角色的路由挂载边界已经落地，`console` 模式通过节点 API 和 `AgentClient` 转发到远程 Agent，不需要 Docker socket。

新增环境变量：

```text
FRPC_MULTI_ROLE=all
FRPC_MULTI_ROLE=console
FRPC_MULTI_ROLE=agent
```

初期默认：

```text
FRPC_MULTI_ROLE=all
```

行为：

- `all`：挂载 `/api/*`、`/agent/*` 和静态前端，兼容当前单机部署。
- `console`：挂载 `/api/*` 和静态前端，不挂载 Docker 执行能力。
- `agent`：只挂载 `/agent/*`，不托管前端。

注意：第一阶段可以先实现配置入口，Console 纯净模式可在后续里程碑补完。

## 里程碑 3：节点管理和 SQLite

目标：Console 开始知道“节点”。

### 任务 3.1：新增 SQLite 存储层

状态：已完成。已新增 SQLite 连接初始化、节点模型和 `NodeStore`，后端测试覆盖数据库文件自动创建和节点 CRUD。

新增文件：

```text
webui/backend/app/control/database.py
webui/backend/app/control/node_store.py
webui/backend/app/control/models.py
```

新增环境变量：

```text
DATABASE_PATH=/data/console.db
```

初期只建 `nodes` 表：

```text
id
name
base_url
token
status
last_seen_at
created_at
updated_at
```

验收：

- 数据库文件能自动创建。
- 节点 CRUD 单元测试通过。

### 任务 3.2：新增节点 API

状态：已完成。已新增 `/api/nodes` CRUD 和 `/api/nodes/{node_id}/ping`，接口使用 Console 登录鉴权，普通响应不返回节点 token。

新增：

```text
GET    /api/nodes
POST   /api/nodes
GET    /api/nodes/{node_id}
PATCH  /api/nodes/{node_id}
DELETE /api/nodes/{node_id}
POST   /api/nodes/{node_id}/ping
```

涉及文件：

```text
webui/backend/app/control/router.py
webui/backend/app/control/node_store.py
webui/backend/app/control/agent_client.py
webui/backend/app/main.py
```

验收：

- 可以新增节点。
- 可以 ping 本机 Agent。
- 节点 token 不在普通列表接口中明文返回。

## 里程碑 4：Console 调用 Agent

目标：实例操作从单机模式过渡为 `nodeId + instanceName`。

### 任务 4.1：实现 AgentClient

状态：已完成。已封装主要 Agent 调用，所有请求携带 Agent token，并通过测试覆盖 401、404、连接失败、超时和 5xx 分类。

新增：

```text
webui/backend/app/control/agent_client.py
```

封装：

```text
ping
get_system
list_instances
create_instance
get_instance
get_config
update_config
start
stop
restart
recreate
logs
summary
stats
```

要求：

- 设置请求超时。
- 区分 401、404、连接失败、超时和 500。
- 所有请求带 Agent token。

### 任务 4.2：新增带 nodeId 的实例 API

状态：已完成。已新增带 `node_id` 的实例列表、创建、详情、启动、停止、重启接口，通过节点存储的 `base_url` 和 token 转发到对应 Agent；旧 `/api/instances` 接口保留。

新增接口：

```text
GET  /api/nodes/{node_id}/instances
POST /api/nodes/{node_id}/instances
GET  /api/nodes/{node_id}/instances/{name}
POST /api/nodes/{node_id}/instances/{name}/start
POST /api/nodes/{node_id}/instances/{name}/stop
POST /api/nodes/{node_id}/instances/{name}/restart
```

先保留旧接口，避免一次性改前端。

验收：

- Console 能通过 API 管理本机 Agent。
- Console 能通过 API 管理一台远程 Agent。

## 里程碑 5：前端加入节点维度

目标：前端从单机实例视图升级为多节点视图。

### 任务 5.1：新增类型和 API 方法

状态：已完成。已新增节点相关前端类型和 `nodesApi` helper，并通过前端构建验证。

涉及文件：

```text
webui/frontend/src/lib/types.ts
webui/frontend/src/lib/api.ts
```

新增类型：

```text
Node
NodeStatus
InstanceRef
NodeSummary
```

### 任务 5.2：新增节点页面

状态：已完成。已新增节点页面，接入侧边栏和 Console 页面切换，支持节点列表、新增、测试连接、删除，并通过前端构建验证。

新增：

```text
webui/frontend/src/pages/NodesPage.tsx
```

修改：

```text
webui/frontend/src/Console.tsx
webui/frontend/src/components/Sidebar.tsx
```

功能：

- 节点列表。
- 新增节点。
- 测试连接。
- 删除节点。

### 任务 5.3：实例页面加入节点选择

状态：已完成。存在节点时创建实例必须选择节点；没有节点时创建页默认使用“本机”并走旧单机兼容 API。实例列表显示节点名称；详情、配置和实例操作已使用 `nodeId + instanceName` 调用节点实例 API，旧单机路径仍保留兼容。

修改：

```text
webui/frontend/src/pages/Overview.tsx
webui/frontend/src/pages/CreateInstance.tsx
webui/frontend/src/pages/Detail.tsx
webui/frontend/src/pages/ConfigEditor.tsx
```

要求：

- 有节点时创建实例必须选择节点；无节点时允许创建到本机。
- 列表显示节点名称。
- 详情页路由包含节点 ID。

验收：

```bash
cd webui/frontend
npm run build
```

## 里程碑 6：多节点聚合、审计和部署

### 任务 6.1：多节点 summary

状态：已完成。`/api/summary` 已支持有节点时聚合所有节点 Agent summary，单节点失败会标记离线且不影响整体响应；无节点时保留单机兼容。

实现：

```text
GET /api/summary
```

行为：

- 聚合所有在线节点。
- 节点离线时返回离线状态。
- 不因为某个节点失败导致整个总览失败。

### 任务 6.2：审计日志

状态：已完成。已新增 `AuditStore`、`audit_logs` 表、`/api/audit-logs` 和前端“审计”页面；节点实例和单机兼容路径的创建、配置更新、删除、启动、停止、重启、重建都会写入审计记录。后端测试覆盖审计记录顺序、操作人、节点、实例名和成功状态。

新增：

```text
audit_logs
GET /api/audit-logs
```

记录：

- 创建实例。
- 修改配置。
- 删除实例。
- 启动。
- 停止。
- 重启。
- 重建。

### 任务 6.3：部署文件

状态：已完成。已新增 Console / Agent 专用 compose 文件，并更新根 README、WebUI README、运维和安全文档，明确单机兼容、Console 分离和 Agent 分离三种路径。

新增：

```text
compose.console.yaml
compose.agent.yaml
```

更新：

```text
README.md
webui/README.md
docs/OPERATIONS.md
docs/SECURITY.md
```

## 第一批实际编码任务

状态：历史建议，已完成。

建议第一批只做以下 5 件事：

```text
1. 新建 app/agent 模块。
2. 抽出 LocalAgentService。
3. 新增 /agent/health、/agent/instances、/agent/summary。
4. 让现有 /api/* 改用 LocalAgentService。
5. 跑后端单元测试，确认单机功能不破。
```

这一批完成后，项目仍然是当前单机 WebUI，但内部已经具备 Agent 边界。之后再进入 SQLite 和多节点。

## 代码执行原则

- 每一批改动后都运行后端测试。
- 前端改动批次必须运行 `npm run build`。
- 不一次性删除旧 API，先兼容再迁移。
- 不在 Console 容器中挂载 Docker socket。
- Agent 是唯一允许挂载 Docker socket 的角色。
- 默认继续保留 `FRPC_MULTI_ROLE=all` 兼容单机部署；生产分离部署使用 `console` / `agent`。
