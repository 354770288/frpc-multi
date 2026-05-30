# frpc 多实例 Docker Compose 部署项目

这是一个面向生产长期运行的 `frpc` 多开部署项目，目标是在一台小型 VPS 上稳定运行多个 `frpc` 实例。项目使用 Docker Compose 作为唯一执行层，每个 `frpc` 实例独立成一个容器，分别拥有独立配置、资源限制、自动重启策略和日志轮转边界。实例由 WebUI 动态创建和管理：在主控（Console）页面新建节点会生成一条一键安装命令，在目标机器运行后 Agent 会主动连回主控并自动上线，随后即可在面板里为该节点创建、启停、查看 `frpc` 实例。

推荐 VPS 配置：

```text
CPU: 1-2 核
内存: 2GB RAM
Swap: 1-2GB
磁盘: 25GB+ SSD
系统: Debian 12 或 Ubuntu 22.04+ LTS
```

本项目不再把"二进制 + systemd"作为主方案。原因是过去已经出现过 `frpc` 长时间运行后内存异常增长并拖垮服务器的问题，所以本项目优先解决隔离、限制、重启、日志和巡检这些长期稳定性问题。

## 架构：Console + Agent（Agent 主动连主控）

参考探针项目的部署方式，本项目采用"主控 + 探针"式的反转连接模型：

```text
Console（主控）  ── 托管前端 + /api/* + /ws/agent（接受 Agent 连接）
     ▲
     │ Agent 主动出站连接（ws/wss 长连接）
     │
Agent（执行端）  ── 出站连回主控 + 挂 docker.sock 管理本机 frpc 实例
```

关键点：**连接方向是 Agent 主动连 Console**，不是 Console 去连 Agent。因此：

- Agent 所在机器无需公网 IP、无需开放任何入站端口，NAT / 家宽 / 内网机器都能纳管，只要它能出站访问主控。
- 主控只需要一个 Agent 能访问到的地址（公网 IP、域名或内网地址）。
- 新增节点不用手填地址和 token：在面板创建节点 → 自动生成 uuid + 密钥 + 一键安装命令 → 在目标机运行命令即自注册上线。
- 主控自身若也要跑 `frpc` 实例，同样在主控机上安装一个 Agent，没有特殊的"单机模式"。

只有两种角色，由 `FRPC_MULTI_ROLE` 决定：

```text
console —— compose.console.yaml，提供前端、/api/* 和 /ws/agent，不挂载 docker.sock
agent   —— compose.agent.yaml，出站连回主控，挂载 docker.sock 管理本机 frpc 实例
```

## 项目结构

```text
.
  compose.yaml                 # frpc 实例容器的基础编排（仅项目名 + 共享网络，被 Agent 引用）
  compose.console.yaml         # 主控 Console 部署入口
  compose.agent.yaml           # Agent 部署入口（出站连回主控）
  compose.generated.yaml       # 由 Agent 根据 instances/ 自动生成的 frpc 服务定义
  .env.example                 # 镜像版本、角色、主控地址、节点凭据等默认值
  instances/                   # 每个 frpc 实例的目录，由 Agent 创建
    <name>/frpc.toml           # 实例配置
    <name>/meta.json           # 实例元数据
  webui/                       # WebUI 前后端（单镜像，多阶段构建）
  scripts/                     # 部署、巡检、备份、swap、Agent 一键安装脚本
  .github/workflows/           # 构建并发布镜像到 GHCR
  docs/                        # 运维、安全、迁移、Agent 安装文档
  backups/                     # 配置备份输出目录
  logs/                        # 预留日志目录
```

## 镜像

Console 和 Agent 是**同一个镜像**，靠 `FRPC_MULTI_ROLE` 区分角色。仓库的 GitHub Actions 会把镜像发布到 GHCR：

```text
ghcr.io/354770288/frpc-multi:latest
```

也可以本地构建：`docker compose -f compose.console.yaml build`。

## 部署主控 Console

```bash
mkdir -p /opt/frpc-multi
rsync -av ./ /opt/frpc-multi/
cd /opt/frpc-multi

cp .env.example .env
sudo bash scripts/install-docker-debian-ubuntu.sh
sudo bash scripts/apply-swap-tuning.sh
nano .env   # 至少设置 WEBUI_PASSWORD、CONSOLE_PUBLIC_HOST
docker compose -f compose.console.yaml up -d --build
```

关键 `.env` 项：

- `WEBUI_PASSWORD`：登录密码，务必修改默认值。
- `CONSOLE_PUBLIC_HOST`：Agent 能访问到的主控地址 `host:port`，例如 `frpc.example.com:8081` 或 `1.2.3.4:8081`。会写进一键安装命令；留空则命令里是占位符，需在目标机手填。
- `CONSOLE_TLS`：主控在 TLS 反代后访问时设为 `true`（安装命令会用 `wss`）。
- `CONSOLE_HOST` / `CONSOLE_PORT`：主控监听地址，默认 `127.0.0.1:8081`。

Console 默认监听 `127.0.0.1:8081`，建议通过 SSH 隧道访问：`ssh -L 8081:127.0.0.1:8081 root@主控IP`，再用浏览器打开 `http://127.0.0.1:8081`。节点数据存于 `/data/console.db`（Docker volume）。

## 添加节点并部署 Agent

1. 登录 Console，进入"节点"页，输入节点名称，点"创建节点"。
2. 页面弹出一条一键安装命令（含该节点的 uuid 和密钥）。复制它。
3. 在目标机器上（已装 Docker）运行该命令。Agent 会拉取镜像、启动并主动连回主控。
4. 几秒后节点在面板变为"在线"，即可为它创建和管理 `frpc` 实例。

详细步骤见 [Agent 安装说明](docs/AGENT_INSTALL.md)。主控自身要跑 frpc 时，同样新建一个节点、在主控机上跑安装命令即可。

## 常用操作

实例的创建、配置、启停、删除、日志都在 Console 页面完成，操作通过 WebSocket 下发到对应 Agent 执行。命令行排查（在 Agent 机器上）：

```bash
# 查看 Agent 容器日志（含连回主控的状态）
docker logs -f frpc-agent

# 查看某个 frpc 实例的日志
docker logs --tail 200 frpc-<instance-name>

# 查看 / 重启全部 frpc 实例
cd /opt/frpc-multi
docker compose -f compose.yaml -f compose.generated.yaml ps
docker compose -f compose.yaml -f compose.generated.yaml restart

# 备份配置
bash scripts/backup-configs.sh
```

## 资源限制策略

默认资源限制写在 `.env.example`：

```text
FRPC_MEMORY_LIMIT=128m
FRPC_CPU_LIMIT=0.25
```

对于 2GB RAM 的 VPS，同时运行约 10 个 `frpc` 实例时，单容器 `128m` 是偏保守的上限。如果业务流量很轻，可以改为 `64m`。如果某个容器反复触发内存上限，不建议直接盲目加大限制，应先查看日志、连接数、代理数量和对应 `frps` 状态。

Docker 日志轮转已经写在 `compose.generated.yaml`（由 WebUI 生成）：

```text
max-size: 10m
max-file: 3
```

这可以避免某个异常实例长期刷日志，把 VPS 磁盘写满。

## 网络模式

默认使用 Docker bridge 网络。容器访问宿主机服务时使用：

```text
host.docker.internal
```

这个映射由生成的 compose 中 `extra_hosts: host-gateway` 提供。

只有在明确需要宿主机网络栈时，才考虑改为 `network_mode: host`。切换前必须检查全部启用实例的端口，避免端口冲突和误暴露。

## 升级与回滚

主控/Agent 镜像版本可固定在各自的部署命令或 `.env`：

```text
AGENT_IMAGE=ghcr.io/354770288/frpc-multi:latest
FRP_IMAGE=ghcr.io/fatedier/frpc:v0.68.1
```

升级主控：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
docker compose -f compose.console.yaml pull
docker compose -f compose.console.yaml up -d
```

升级 Agent：在 Agent 机器上重新运行一键安装命令（脚本会用新镜像重建容器），或 `docker pull` 后重建。

## 相关文档

- [运维手册](docs/OPERATIONS.md)
- [安全说明](docs/SECURITY.md)
- [Agent 安装说明](docs/AGENT_INSTALL.md)
- [从旧架构迁移](docs/MIGRATION.md)
- [二期管理平台规划](docs/PHASE-2.md)
- [WebUI 使用说明](webui/README.md)
