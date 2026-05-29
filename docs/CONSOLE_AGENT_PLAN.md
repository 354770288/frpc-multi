# frpc-multi Console + Agent 改造计划书

## 1. 背景

当前项目已经实现了单机版 WebUI：

- 前端使用 React + Vite + Tailwind，构建后由 FastAPI 后端托管静态文件。
- 后端使用 FastAPI，提供登录、实例管理、配置校验、日志查看和系统信息接口。
- 后端通过挂载 `/var/run/docker.sock` 和项目目录，调用本机 `docker compose` 管理 frpc 容器。
- 每个 frpc 实例对应 `instances/<name>/frpc.toml` 和 `instances/<name>/meta.json`。
- `compose.generated.yaml` 由后端根据实例目录动态生成。

这套架构适合单台 VPS，但不适合管理多台 frpc 服务器。多服务器场景下，如果主控服务直接通过 SSH 或远程 Docker API 管理各服务器，会带来权限过大、网络暴露、故障定位困难和长期维护复杂等问题。

因此，本次重大改造决定采用 **Console + Agent 双角色架构**：

- 主 VPS 部署前端和主控 API，作为统一管理端。
- 每台 frpc 服务器部署 Docker Agent，只管理本机 Docker 和本机实例文件。
- 前端只访问主控 API，不直接访问任何 Agent。
- 主控 API 负责节点管理、用户认证、操作转发、状态聚合和审计。

本计划放弃 Cloudflare 托管前端方案，避免形成前端、主控 API、Agent 三端部署复杂度。

## 2. 目标

### 2.1 核心目标

将项目从单机 WebUI 改造为可管理多台 frpc 服务器的分布式管理系统。

目标部署形态：

```text
主 VPS
  frpc-console
    - React 前端
    - Control Plane API
    - SQLite 管理库
    - 用户登录
    - 节点管理
    - 全局实例视图
    - 操作审计

frpc 服务器 A
  frpc-agent
    - 本地 instances/
    - 本地 compose.generated.yaml
    - 本地 Docker socket
    - 本机 frpc 容器管理

frpc 服务器 B
  frpc-agent
    - 本地 instances/
    - 本地 compose.generated.yaml
    - 本地 Docker socket
    - 本机 frpc 容器管理
```

### 2.2 非目标

本阶段不做以下事项：

- 不把前端部署到 Cloudflare、Vercel、Netlify 等无服务器平台。
- 不让主控 API 直接访问远程 Docker API。
- 不通过主控 API SSH 到各服务器执行 Docker 命令。
- 不做复杂多租户权限体系。
- 不引入 Kubernetes。
- 不强制引入 PostgreSQL；初期使用 SQLite。
- 不同时维护 Docker 和 systemd 两套执行层。

## 3. 架构设计

### 3.1 角色划分

系统拆分为两个运行角色：

```text
console
agent
```

`console` 是管理端，部署在主 VPS。

职责：

- 托管前端页面。
- 提供用户登录和主控 API。
- 管理节点列表。
- 保存节点连接信息。
- 聚合各节点实例状态。
- 将实例操作转发给对应 Agent。
- 保存审计日志。
- 保存全局实例索引和最近一次状态缓存。

`agent` 是执行端，部署在每台 frpc 服务器。

职责：

- 管理本机 `instances/` 目录。
- 校验和写入本机 frpc 配置。
- 生成本机 `compose.generated.yaml`。
- 调用本机 Docker Compose 启停 frpc 容器。
- 返回本机实例状态、日志和系统信息。
- 不保存主控用户信息。
- 不管理其他服务器。

### 3.2 调用链路

```text
Browser
  -> Console API
    -> Agent API
      -> local Docker Compose
        -> frpc containers
```

前端永远只访问 Console API。Agent API 不面向浏览器开放。

### 3.3 安全边界

安全边界必须清晰：

- Docker socket 只挂载在 Agent 容器中。
- Console 不挂载任何远程服务器的 Docker socket。
- Agent API 必须启用 token 鉴权。
- Console 保存 Agent token 时不得明文展示。
- Agent 建议只监听内网、VPN、Tailscale、WireGuard、Cloudflare Tunnel 或 HTTPS 反向代理后的地址。
- 不建议将 Agent 的 HTTP 服务裸露到公网。

## 4. 数据模型

### 4.1 Console 数据库

Console 使用 SQLite 保存管理数据。建议数据库文件：

```text
data/console.db
```

初期表设计：

```text
users
  id
  username
  password_hash
  created_at
  updated_at

nodes
  id
  name
  base_url
  token_secret_ref
  status
  last_seen_at
  version
  tags
  created_at
  updated_at

instance_index
  node_id
  instance_name
  display_name
  enabled
  description
  last_state
  last_status
  last_seen_at
  created_at
  updated_at

audit_logs
  id
  username
  action
  node_id
  instance_name
  success
  message
  created_at
```

实例唯一键从当前单机的：

```text
name
```

调整为：

```text
node_id + instance_name
```

### 4.2 Agent 本地数据

Agent 继续使用当前文件布局：

```text
instances/
  <name>/
    frpc.toml
    meta.json

compose.generated.yaml
```

Agent 是本机实例配置的真实来源。Console 的 `instance_index` 只是全局索引和状态缓存。

## 5. API 设计

### 5.1 Console API

前端调用 Console API。

节点管理：

```text
GET    /api/nodes
POST   /api/nodes
GET    /api/nodes/{node_id}
PATCH  /api/nodes/{node_id}
DELETE /api/nodes/{node_id}
POST   /api/nodes/{node_id}/ping
GET    /api/nodes/{node_id}/system
```

实例管理：

```text
GET    /api/instances
POST   /api/instances
GET    /api/instances/{node_id}/{name}
PATCH  /api/instances/{node_id}/{name}
DELETE /api/instances/{node_id}/{name}
GET    /api/instances/{node_id}/{name}/config
PUT    /api/instances/{node_id}/{name}/config
POST   /api/instances/{node_id}/{name}/config/validate
POST   /api/instances/{node_id}/{name}/start
POST   /api/instances/{node_id}/{name}/stop
POST   /api/instances/{node_id}/{name}/restart
POST   /api/instances/{node_id}/{name}/recreate
GET    /api/instances/{node_id}/{name}/logs
GET    /api/instances/{node_id}/{name}/logs/stream
```

聚合信息：

```text
GET    /api/summary
GET    /api/stats
GET    /api/audit-logs
GET    /api/system
```

### 5.2 Agent API

Console 调用 Agent API。

健康和系统：

```text
GET    /agent/health
GET    /agent/system
GET    /agent/summary
GET    /agent/stats
```

实例管理：

```text
GET    /agent/instances
POST   /agent/instances
GET    /agent/instances/{name}
PATCH  /agent/instances/{name}
DELETE /agent/instances/{name}
GET    /agent/instances/{name}/config
PUT    /agent/instances/{name}/config
POST   /agent/instances/{name}/config/validate
POST   /agent/instances/{name}/start
POST   /agent/instances/{name}/stop
POST   /agent/instances/{name}/restart
POST   /agent/instances/{name}/recreate
GET    /agent/instances/{name}/logs
GET    /agent/instances/{name}/logs/stream
POST   /agent/compose/regenerate
```

Agent API 使用：

```text
Authorization: Bearer <agent-token>
```

## 6. 前端改造

当前前端主要围绕单机实例设计。多节点后需要增加节点维度。

### 6.1 新增页面

新增节点管理页：

```text
NodesPage
```

功能：

- 查看所有节点。
- 新增节点。
- 编辑节点名称和地址。
- 测试节点连接。
- 查看节点最近在线时间。
- 查看节点系统信息。
- 删除节点。

### 6.2 修改页面

`Overview`：

- 增加节点筛选。
- 实例列表增加节点列。
- 聚合显示所有节点实例。
- 节点离线时实例状态显示为不可达。

`CreateInstance`：

- 新增目标节点选择。
- 创建请求必须带 `nodeId`。

`Detail`：

- 路由从单一 `name` 改为 `nodeId + name`。
- 页面显示所属节点。
- 日志和操作通过 Console 转发到对应 Agent。

`ConfigEditor`：

- 校验配置时请求对应节点 Agent。
- 保存配置后可选择是否重启对应节点实例。

`SystemPage`：

- 拆分为主控系统信息和节点系统信息。
- 支持按节点查看 Docker 版本、frp 镜像、磁盘空间等。

### 6.3 前端 API 层

`src/lib/api.ts` 保持统一请求入口，但类型层需要增加：

```text
Node
NodeStatus
InstanceRef
ConsoleSummary
AgentSystemInfo
```

所有实例操作都必须携带节点标识。

## 7. 后端改造

### 7.1 模块拆分

建议后端重组为：

```text
webui/backend/app/
  main.py
  settings.py
  auth.py
  shared/
    models.py
    config_validator.py
    errors.py
  agent/
    router.py
    instance_store.py
    compose_generator.py
    docker_service.py
    service.py
    auth.py
  control/
    router.py
    database.py
    node_store.py
    agent_client.py
    instance_service.py
    audit.py
```

`main.py` 根据环境变量启用角色：

```text
FRPC_MULTI_ROLE=console
FRPC_MULTI_ROLE=agent
FRPC_MULTI_ROLE=all
```

开发阶段可以保留 `all`，生产建议明确使用 `console` 或 `agent`。

### 7.2 迁移当前能力

迁到 Agent：

- `InstanceStore`
- `DockerService`
- `compose_generator`
- `config_validator`
- 本机日志流
- 本机系统信息

迁到 Control：

- 用户登录
- 节点管理
- 全局 summary
- Agent HTTP client
- 审计日志

### 7.3 Agent Client

Console 内部新增 `AgentClient`：

```text
AgentClient.ping(node)
AgentClient.list_instances(node)
AgentClient.create_instance(node, payload)
AgentClient.start_instance(node, name)
AgentClient.stop_instance(node, name)
AgentClient.restart_instance(node, name)
AgentClient.get_logs(node, name)
AgentClient.stream_logs(node, name)
```

必须处理：

- 连接超时。
- Agent token 错误。
- Agent 返回 4xx。
- Agent 返回 5xx。
- 节点离线。
- 日志流中断。

## 8. 部署设计

### 8.1 Console 部署

主 VPS 部署：

```yaml
name: frpc-multi-console

services:
  frpc-console:
    build:
      context: ./webui
    container_name: frpc-console
    restart: unless-stopped
    environment:
      FRPC_MULTI_ROLE: console
      WEBUI_HOST: 0.0.0.0
      WEBUI_PORT: 8081
      WEBUI_USERNAME: ${WEBUI_USERNAME:-admin}
      WEBUI_PASSWORD: ${WEBUI_PASSWORD:-change-this-password}
      WEBUI_JWT_SECRET: ${WEBUI_JWT_SECRET}
      DATABASE_URL: sqlite:////data/console.db
    ports:
      - "${WEBUI_HOST:-127.0.0.1}:${WEBUI_PORT:-8081}:8081"
    volumes:
      - ./data:/data
```

Console 不挂载 Docker socket。

### 8.2 Agent 部署

每台 frpc 服务器部署：

```yaml
name: frpc-multi-agent

services:
  frpc-agent:
    build:
      context: ./webui
    container_name: frpc-agent
    restart: unless-stopped
    environment:
      FRPC_MULTI_ROLE: agent
      PROJECT_DIR: /opt/frpc-multi
      AGENT_HOST: 0.0.0.0
      AGENT_PORT: 8082
      AGENT_TOKEN: ${AGENT_TOKEN}
    ports:
      - "${AGENT_HOST_BIND:-127.0.0.1}:${AGENT_PORT:-8082}:8082"
    volumes:
      - ./:/opt/frpc-multi
      - /var/run/docker.sock:/var/run/docker.sock
```

Agent 保留 Docker socket 挂载，因为它就是本机执行层。

### 8.3 网络建议

优先级从高到低：

1. 主 VPS 和 Agent 服务器在同一内网或 VPN。
2. 使用 Tailscale / WireGuard，让 Console 访问 Agent 内网地址。
3. 使用 HTTPS 反向代理暴露 Agent，并限制来源 IP。
4. 最后才考虑公网开放 Agent 端口。

不建议：

- 公网 HTTP 暴露 Agent。
- 弱 token。
- 多台 Agent 共用同一个 token。

## 9. 实施阶段

### 阶段 1：角色边界整理

目标：在不改变现有功能的前提下，把当前单机能力整理成 Agent 服务。

任务：

- 新增 Agent router。
- 将实例文件管理、Compose 生成、Docker 调用迁入 Agent 模块。
- 保留当前 `/api/*` 行为，用本机 Agent service 承接。
- 增加 Agent token 鉴权框架。

验收：

- 单机部署行为不变。
- 原有测试通过。
- 当前 WebUI 仍可创建、启动、停止、删除实例。

### 阶段 2：新增 Console 节点管理

目标：Console 开始保存节点信息。

任务：

- 引入 SQLite。
- 新增 `nodes` 表。
- 新增节点 CRUD API。
- 新增 Agent 连接测试 API。
- 前端新增节点管理页。

验收：

- 可以在前端新增一个 Agent 节点。
- 可以测试节点连接。
- 节点离线时显示明确错误。

### 阶段 3：Console 转发实例操作

目标：前端通过 Console 管理指定节点上的实例。

任务：

- 新增 `AgentClient`。
- `/api/instances` 支持 `nodeId`。
- 创建、编辑、启停、日志接口转发到对应 Agent。
- 新增 `instance_index` 缓存。
- 前端实例列表增加节点维度。

验收：

- 主 VPS 上的前端可以管理至少一台远程 Agent。
- 创建实例写入远程 Agent 的 `instances/`。
- 启停操作只影响目标节点。
- 日志能通过 Console 查看。

### 阶段 4：多节点聚合

目标：Console 能展示所有节点状态和所有实例状态。

任务：

- `/api/summary` 聚合所有在线节点。
- 节点离线时使用最近缓存。
- Overview 支持节点筛选。
- SystemPage 支持查看不同节点系统信息。

验收：

- 两台 Agent 同时在线时，Overview 能看到两台节点上的实例。
- 其中一台 Agent 离线时，前端不崩溃，并显示节点不可达。
- 聚合统计区正确显示总数、运行数、停止数、错误数。

### 阶段 5：审计和安全加固

目标：多服务器操作可追踪，关键凭据更安全。

任务：

- 新增 `audit_logs` 表。
- 对创建、修改、删除、启动、停止、重启、重建记录审计。
- Agent token 保存时避免前端回显。
- 增加请求超时和错误分类。
- 文档补充 Agent 暴露安全要求。

验收：

- 每次高风险操作都有审计记录。
- 节点 token 不会在前端明文展示。
- Agent token 错误、节点超时、Docker 错误能区分显示。

### 阶段 6：部署文档和迁移

目标：让现有单机用户可以迁移到 Console + Agent 架构。

任务：

- 新增 `compose.console.yaml`。
- 新增 `compose.agent.yaml`。
- 更新部署脚本。
- 编写从当前单机版迁移到本机 Console + Agent 的步骤。
- 编写新增远程 Agent 节点的步骤。

验收：

- 全新主 VPS 可以部署 Console。
- 全新 frpc 服务器可以部署 Agent。
- 已有 `instances/` 目录可以被 Agent 继续识别。
- 文档能指导完成一主一 Agent 部署。

## 10. 测试计划

### 10.1 单元测试

覆盖：

- 节点模型和节点存储。
- Agent token 鉴权。
- AgentClient 错误处理。
- 实例名校验。
- Compose 生成。
- 配置校验。
- 审计记录写入。

### 10.2 集成测试

覆盖：

- Console 调用本机测试 Agent。
- 创建实例。
- 修改配置。
- 启动实例。
- 停止实例。
- 删除实例。
- 获取日志。
- 节点离线错误处理。

### 10.3 手工验收

至少准备两台服务器：

```text
主 VPS: console
节点 A: agent
节点 B: agent
```

验收项：

- Console 能添加节点 A 和节点 B。
- Console 能检测两个节点在线。
- 能在节点 A 创建实例。
- 能在节点 B 创建实例。
- 节点 A 的启停不影响节点 B。
- 停掉节点 B 的 Agent 后，前端显示节点 B 离线。
- 节点 B 恢复后，状态能重新同步。
- 日志查看和日志流可用。
- 审计日志记录操作人、节点、实例和结果。

## 11. 风险与应对

### 11.1 Docker socket 风险

风险：

Agent 挂载 Docker socket，Agent 被攻破等同于本机 Docker 控制权泄露。

应对：

- Agent 只部署在可信服务器。
- Agent API 不裸露公网。
- 使用强 token。
- 后续可考虑 HTTPS 双向认证或 VPN。

### 11.2 节点离线

风险：

Console 无法实时获取实例状态。

应对：

- Console 缓存最近一次实例状态。
- 前端明确显示节点离线。
- 操作离线节点时直接失败，不做假成功。

### 11.3 日志流复杂度

风险：

Console 代理 Agent SSE 日志流时可能出现中断、超时和反向代理缓冲。

应对：

- 初期保留普通日志拉取。
- SSE 作为增强能力。
- 文档说明 Nginx/Caddy 关闭缓冲。

### 11.4 数据一致性

风险：

Agent 本地文件是实例真实来源，Console 索引可能过期。

应对：

- Console 每次进入节点或总览时刷新节点摘要。
- `instance_index` 只作为缓存，不作为配置真实来源。
- 配置读取始终从 Agent 获取。

### 11.5 实例名冲突

风险：

不同节点可能存在同名实例。

应对：

- API 和前端路由使用 `node_id + instance_name`。
- 前端显示节点名称，避免误操作。

## 12. 推荐实现顺序

推荐按以下顺序实施：

1. 把当前单机 Docker 管理能力整理为 Agent service。
2. 新增 Agent API 和 token 鉴权。
3. 新增 Console SQLite 和节点管理。
4. 新增 AgentClient，完成 Console 到 Agent 的实例操作转发。
5. 修改前端，加入节点管理和实例节点维度。
6. 实现多节点 summary 聚合。
7. 增加审计日志和错误分类。
8. 拆分部署文件和迁移文档。

这个顺序可以保证每一步都有可运行状态，不需要一次性重写整个项目。

## 13. 最终验收标准

项目完成后应满足：

- 主 VPS 只部署一个 Console 容器即可访问完整 Web 管理界面。
- 每台 frpc 服务器只需要部署一个 Agent 容器。
- Console 不需要挂载 Docker socket。
- Agent 只管理本机 Docker 和本机 frpc 实例。
- 前端可以查看所有节点和所有实例。
- 前端可以在指定节点创建、编辑、启动、停止、重启和删除实例。
- 前端可以查看指定节点实例日志。
- 节点离线时有明确状态提示。
- 高风险操作有审计记录。
- 已有单机实例目录可以平滑迁移到 Agent。
