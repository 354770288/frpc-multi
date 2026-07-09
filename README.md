# frpc-multi

集中管理多台机器上 `frpc` 实例的 Web 面板。主控（Console）提供页面和 API，每台执行机装一个 Agent 主动连回主控；每个 `frpc` 实例独立容器运行，自带内存/CPU 限制、自动重启和日志轮转，适合在小型 VPS 上长期稳定运行。

## 工作方式

```text
Console（主控）  ── 托管前端 + /api/* + /ws/agent
     ▲
     │ Agent 主动出站连接（ws/wss 长连接）
     │
Agent（执行端）  ── 挂 docker.sock，管理本机 frpc 实例容器
```

- **连接方向是 Agent 连 Console**：Agent 机器无需公网 IP、无需开放任何入站端口，NAT / 家宽 / 内网机器都能纳管。
- **加节点零配置**：面板创建节点 → 复制一键安装命令 → 目标机运行，几秒后自动上线。
- **同一个镜像**：`ghcr.io/354770288/frpc-multi:latest`，用 `FRPC_MULTI_ROLE=console|agent` 区分角色。
- **没有单机模式**：主控机自己也要跑 frpc 时，同样给它装一个 Agent。

## 快速开始

一台 1-2 核 / 2GB RAM 的 VPS（Debian 12 / Ubuntu 22.04+）即可作为主控。目标机需已装 Docker（可用 `scripts/install-docker-debian-ubuntu.sh`）。

### 1. 部署主控 Console

```bash
mkdir -p /opt/frpc-multi && cd /opt/frpc-multi
# 放入 compose.console.yaml 和 .env.example（或 clone 整个仓库）
cp .env.example .env
nano .env
docker compose -f compose.console.yaml up -d
```

`.env` 至少设置两项：

- `WEBUI_PASSWORD`：登录密码。
- `CONSOLE_PUBLIC_HOST`：Agent 能访问到的主控地址 `host:port`（如 `frpc.example.com:8081`），会写进一键安装命令。

Console 默认监听 `127.0.0.1:8081`，建议 SSH 隧道访问：

```bash
ssh -L 8081:127.0.0.1:8081 root@主控IP   # 浏览器打开 http://127.0.0.1:8081
```

### 2. 添加节点

1. 登录面板，进入"节点"页，输入名称，点"创建节点"。
2. 复制弹出的一键安装命令。
3. 在目标机运行该命令，节点几秒后变为"在线"。

### 3. 管理实例

实例的创建、配置编辑、启停、日志（实时跟随）、审计全部在面板完成，操作经 WebSocket 下发到对应 Agent 执行。实例配置落在 Agent 机器的 `instances/<name>/frpc.toml`。

## 项目结构

```text
compose.console.yaml   # 主控部署入口
compose.agent.yaml     # Agent 部署入口（手动 compose 方式）
compose.yaml           # frpc 实例容器的基础编排（由 Agent 引用）
.env.example           # 全部配置项与默认值
webui/                 # WebUI 前后端（单镜像，多阶段构建）
scripts/               # 巡检、备份、swap、Agent 安装等脚本
systemd/               # 每日健康检查的 service / timer
docs/                  # 详细文档（见下）
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署与验证](docs/DEPLOY_VERIFY.md) | 用 GHCR 镜像在 VPS 上完整部署、验证清单、常见问题 |
| [Agent 安装](docs/AGENT_INSTALL.md) | 一键安装、compose 方式、TLS/反代、升级与排查 |
| [运维手册](docs/OPERATIONS.md) | 日常巡检、健康检查、资源限制、升级回滚、备份恢复 |
| [安全说明](docs/SECURITY.md) | 角色边界、凭据管理、网络暴露面 |
| [WebUI 说明](webui/README.md) | 页面结构与本地开发 |
| [旧架构迁移](docs/MIGRATION.md) | 从旧版（Console 主动 HTTP 连接 / all 模式）迁移 |
