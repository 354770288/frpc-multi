<div align="center">

# 🌉 frpc-multi

**集中管理多台机器上 `frpc` 实例的 Web 面板**

Agent 主动回连 · 无需公网 IP · 一键安装上线

[![构建并发布镜像](https://github.com/354770288/frpc-multi/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/354770288/frpc-multi/actions/workflows/docker-publish.yml)
[![镜像](https://img.shields.io/badge/ghcr.io-frpc--multi-2496ED?logo=docker&logoColor=white)](https://github.com/354770288/frpc-multi/pkgs/container/frpc-multi)

</div>

主控（Console）提供页面和 API，每台执行机装一个 Agent 主动连回主控。每个 `frpc` 实例独立容器运行，自带内存/CPU 限制、自动重启和日志轮转，适合在小型 VPS 上长期稳定运行。

## ✨ 特性

- 🔌 **反向连接** — Agent 主动连 Console，执行机无需公网 IP、无需开放任何入站端口，NAT / 家宽 / 内网机器都能纳管
- ⚡ **加节点零配置** — 面板创建节点 → 复制一键安装命令 → 目标机运行，几秒后自动上线
- 📦 **单镜像双角色** — 同一个 `ghcr.io/354770288/frpc-multi:latest`，用 `FRPC_MULTI_ROLE=console|agent` 区分
- 🖥️ **全面板操作** — 实例创建、配置编辑、启停、实时日志、审计都在 WebUI 完成，支持暗色模式
- 🧪 **frps 穿透测试** — 内置候选 frps 服务器验收：tcping 探活 → 建隧道 → 验证映射端口放行 → 双隧道实测上下行速率；结果落库、历史可查，测试通过的服务器一键创建 frpc 实例（测试在 Console 内执行，frpc 二进制已打进镜像）
- ⚖️ **负载均衡（Cloudflare DDNS 域名池）** — 候选域名绑定服务器库健康分组，同步为 Cloudflare 多条灰云 A 记录；frpc 填域名即得 DNS 轮询负载均衡与故障切换，支持手动/定时同步

## 🏗️ 工作方式

```text
Console（主控）  ── 托管前端 + /api/* + /ws/agent
     ▲
     │ Agent 主动出站连接（ws/wss 长连接）
     │
Agent（执行端）  ── 挂 docker.sock，管理本机 frpc 实例容器
```

主控机自己也要跑 frpc？没有特殊的单机模式——同样给它装一个 Agent 即可。

## 🚀 快速开始

> 一台 1-2 核 / 2GB RAM 的 VPS（Debian 12 / Ubuntu 22.04+）即可作为主控。
> 目标机需已装 Docker（可用 `scripts/install-docker-debian-ubuntu.sh`）。

### 1️⃣ 部署主控 Console

```bash
mkdir -p /opt/frpc-multi && cd /opt/frpc-multi
# 放入 compose.console.yaml 和 .env.example（或 clone 整个仓库）
cp .env.example .env
nano .env
docker compose -f compose.console.yaml up -d
```

`.env` 至少设置两项：

| 变量 | 说明 |
| --- | --- |
| `WEBUI_PASSWORD` | 登录密码 |
| `CONSOLE_PUBLIC_HOST` | Agent 能访问到的主控地址 `host:port`（如 `frpc.example.com:8081`），会写进一键安装命令 |

Console 默认监听 `127.0.0.1:8081`，建议 SSH 隧道访问：

```bash
ssh -L 8081:127.0.0.1:8081 root@主控IP   # 浏览器打开 http://127.0.0.1:8081
```

### 2️⃣ 添加节点

1. 登录面板，进入「节点」页，输入名称，点「创建节点」
2. 复制弹出的一键安装命令
3. 在目标机运行该命令，节点几秒后变为「在线」✅

### 3️⃣ 管理实例

实例的创建、配置编辑、启停、日志（实时跟随）、审计全部在面板完成，操作经 WebSocket 下发到对应 Agent 执行。实例配置落在 Agent 机器的 `instances/<name>/frpc.toml`。

### 4️⃣ 穿透测试（frps 验收）

选 frps 服务器前先在「服务器库」页验收：

1. 添加或批量导入候选服务器（支持粘贴 IP 列表或原「FRPC穿透测试」项目导出的 JSON）
2. 「一键完整测试」：连通性（可达 + 隧道 + 端口放行）通过的服务器自动续接上下行速率测试，测试在服务端执行，关页面不停任务
3. 测试通过的服务器点「创建实例」，frps 地址自动填入实例创建表单

要求 frps 侧放行 `PROBE_BASE_PORT` 起的三个测试端口（默认 11561-11563）+ 服务端口（默认 7000）；端口与时长可通过 `.env` 的 `PROBE_*` 配置调整（见 `.env.example`）。

### 5️⃣ 负载均衡（Cloudflare DDNS 域名池）

把多台高可用 frps 聚到一个域名后面，frpc 填域名即得负载均衡：

1. 「负载均衡」页配置 Cloudflare API Token（Zone 读 + DNS 编辑权限）
2. 新增候选域名：选 Zone、填域名（如 `frps.example.com`）、绑定服务器库的一个分组、选 TTL（建议 ≤120s）与同步模式（手动/定时）
3. 同步：分组内服务器 IP 自动写为该域名的多条灰云 A 记录；把服务器移出分组再同步即摘除
4. 创建 frpc 实例时「地址来源」选「负载均衡域名」，serverAddr 自动填该域名

只增删带 `frpc-multi-lb` 托管标记的 A 记录，手动添加的 DNS 记录不受影响；定时同步由 Console 后台线程按各域名配置的间隔执行。

## 📂 项目结构

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

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| 🧪 [部署与验证](docs/DEPLOY_VERIFY.md) | 用 GHCR 镜像在 VPS 上完整部署、验证清单、常见问题 |
| 🤖 [Agent 安装](docs/AGENT_INSTALL.md) | 一键安装、compose 方式、TLS/反代、升级与排查 |
| 🔧 [运维手册](docs/OPERATIONS.md) | 日常巡检、健康检查、资源限制、升级回滚、备份恢复 |
| 🔐 [安全说明](docs/SECURITY.md) | 角色边界、凭据管理、网络暴露面 |
| 🖥️ [WebUI 说明](webui/README.md) | 页面结构与本地开发 |
| 📜 [旧架构迁移](docs/MIGRATION.md) | 从旧版（Console 主动 HTTP 连接 / all 模式）迁移 |

---

<div align="center">

Enjoy! 🎉

</div>
