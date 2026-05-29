# frpc 多实例 Docker Compose 部署项目

这是一个面向生产长期运行的 `frpc` 多开部署项目，目标是在一台小型 VPS 上稳定运行多个 `frpc` 实例。项目使用 Docker Compose 作为唯一执行层，每个 `frpc` 实例独立成一个容器，分别拥有独立配置、资源限制、自动重启策略和日志轮转边界。实例由 WebUI 动态创建和管理，单机兼容模式在本机执行，Console / Agent 分离模式由 Agent 执行，写入 `instances/<name>/frpc.toml` 并生成 `compose.generated.yaml`。

推荐 VPS 配置：

```text
CPU: 1-2 核
内存: 2GB RAM
Swap: 1-2GB
磁盘: 25GB+ SSD
系统: Debian 12 或 Ubuntu 22.04+ LTS
```

本项目不再把"二进制 + systemd"作为主方案。原因是过去已经出现过 `frpc` 长时间运行后内存异常增长并拖垮服务器的问题，所以本项目优先解决隔离、限制、重启、日志和巡检这些长期稳定性问题。

## 项目结构

```text
.
  compose.yaml                 # 单机兼容入口，运行 WebUI/all 角色并挂载 Docker socket
  compose.console.yaml         # Console 独立部署入口，不挂载 Docker socket
  compose.agent.yaml           # Agent 独立部署入口，挂载 Docker socket 管理本机实例
  compose.generated.yaml       # 由本机执行层/Agent 根据 instances/ 自动生成
  .env.example                 # 镜像版本、内存限制、CPU 限制等默认值
  instances/                   # 每个 frpc 实例的目录，由本机兼容路径或 Agent 创建
    <name>/frpc.toml           # 实例配置
    <name>/meta.json           # 实例元数据
  webui/                       # WebUI 前后端
  scripts/                     # 部署、巡检、备份、swap 调整脚本
  systemd/                     # 每日健康检查 timer
  docs/                        # 运维、安全、二期管理平台文档
  backups/                     # 配置备份输出目录
  logs/                        # 预留日志目录
```

## 首次部署到 VPS

以下命令假设项目部署目录为 `/opt/frpc-multi`。

```bash
mkdir -p /opt/frpc-multi
rsync -av ./ /opt/frpc-multi/
cd /opt/frpc-multi

cp .env.example .env
sudo bash scripts/install-docker-debian-ubuntu.sh
sudo bash scripts/apply-swap-tuning.sh
```

启动 WebUI（单机兼容模式，默认 `FRPC_MULTI_ROLE=all`）：

```bash
bash scripts/deploy.sh
```

`deploy.sh` 会在发现 `instances/` 里仍存在 `CHANGE_ME` 时拒绝启动，避免把未配置好的实例直接跑到生产环境。

之后浏览器打开 `http://127.0.0.1:8081`（建议通过 SSH 隧道），登录后在 WebUI 内创建 frpc 实例。没有配置节点时，创建页会默认选择“本机”，继续走旧的单机 `/api/instances` 兼容路径；WebUI 在每次创建/启动实例时会刷新 `compose.generated.yaml` 并执行 `docker compose -f compose.yaml -f compose.generated.yaml up -d <service>`。

## Console / Agent 分离部署

当前有三种运行路径：

```text
单机兼容：compose.yaml，FRPC_MULTI_ROLE=all，同时提供前端、Console API、本机 Agent API 和本机 Docker 执行能力。
Console：compose.console.yaml，FRPC_MULTI_ROLE=console，只提供前端和 /api/*，不挂载 Docker socket。
Agent：compose.agent.yaml，FRPC_MULTI_ROLE=agent，只提供 /agent/*，挂载 Docker socket 管理本机实例。
```

注意：`compose.console.yaml` 会在 compose 文件内固定 `FRPC_MULTI_ROLE=console`，不会因为 `.env` 写了 `FRPC_MULTI_ROLE=all` 就启动本机 Agent 能力，也不会监听 `8082`。如果要单机 all-in-one，请使用 `compose.yaml`；如果要分离部署，请在执行节点单独启动 `compose.agent.yaml`。

默认 `compose.yaml` 适合一台 VPS 同时运行管理界面和本机 frpc 实例。多服务器管理时，使用专用 compose 文件：

主控 Console 服务器：

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env
docker compose -f compose.console.yaml up -d --build
```

Console 默认监听：

```text
127.0.0.1:8081
```

frpc Agent 服务器：

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env
docker compose -f compose.agent.yaml up -d --build
```

Agent 启动前必须在 `.env` 中设置高强度 `AGENT_TOKEN`。`compose.agent.yaml` 默认启用 `AGENT_AUTH_ENABLED=true`，并把容器内 `8081` 映射到宿主机：

```text
127.0.0.1:8082
```

如果 Console 和 Agent 不在同一台机器，建议通过内网、VPN、Tailscale、WireGuard、Cloudflare Tunnel 或 HTTPS 反向代理连通 Agent，不建议把 Agent HTTP 服务裸露到公网。Console 页面中新增节点时，节点地址填写 Agent 的可访问地址（例如 `http://10.0.0.12:8082`），token 填写对应 Agent 的 `AGENT_TOKEN`。添加节点后，实例创建、详情、配置、启动、停止、重启、删除会走 `nodeId + instanceName` 的多节点路径；没有任何节点时仍保留本机兼容路径。

## 常用操作

查看所有实例状态：

```bash
cd /opt/frpc-multi
docker compose -f compose.yaml -f compose.generated.yaml ps
bash scripts/check-health.sh
```

重启单个实例：

```bash
cd /opt/frpc-multi
bash scripts/restart-one.sh <instance-name>
```

重启全部实例：

```bash
cd /opt/frpc-multi
docker compose -f compose.yaml -f compose.generated.yaml restart
```

备份当前配置：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
```

查看单个实例日志：

```bash
cd /opt/frpc-multi
docker logs --tail 200 frpc-<instance-name>
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

镜像版本固定在 `.env`：

```text
FRP_IMAGE=ghcr.io/fatedier/frpc:v0.68.1
```

升级流程：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
nano .env
docker compose -f compose.yaml -f compose.generated.yaml pull
docker compose -f compose.yaml -f compose.generated.yaml up -d
bash scripts/check-health.sh
```

回滚流程：

```bash
cd /opt/frpc-multi
nano .env
docker compose -f compose.yaml -f compose.generated.yaml pull
docker compose -f compose.yaml -f compose.generated.yaml up -d
bash scripts/check-health.sh
```

建议每次升级前先备份配置，并只修改 `.env` 里的 `FRP_IMAGE` 版本号。

## 相关文档

- [运维手册](docs/OPERATIONS.md)
- [安全说明](docs/SECURITY.md)
- [二期管理平台规划](docs/PHASE-2.md)
- [WebUI 使用说明](webui/README.md)
