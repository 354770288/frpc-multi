# frpc 多实例 Docker Compose 部署项目

这是一个面向生产长期运行的 `frpc` 多开部署项目，目标是在一台小型 VPS 上稳定运行多个 `frpc` 实例。项目使用 Docker Compose 作为唯一执行层，每个 `frpc` 实例独立成一个容器，分别拥有独立配置、资源限制、自动重启策略和日志轮转边界。实例由 WebUI 动态创建和管理，写入 `instances/<name>/frpc.toml`，并由后端生成 `compose.generated.yaml`。

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
  compose.yaml                 # 仅管理 WebUI 服务和共享 network
  compose.generated.yaml       # 由 WebUI 根据 instances/ 自动生成（首次启动 WebUI 后出现）
  .env.example                 # 镜像版本、内存限制、CPU 限制等默认值
  instances/                   # 每个 frpc 实例的目录，由 WebUI 创建
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

启动 WebUI（首次只起 webui 容器）：

```bash
bash scripts/deploy.sh
```

`deploy.sh` 会在发现 `instances/` 里仍存在 `CHANGE_ME` 时拒绝启动，避免把未配置好的实例直接跑到生产环境。

之后浏览器打开 `http://127.0.0.1:8081`（建议通过 SSH 隧道），登录后在 WebUI 内创建 frpc 实例。WebUI 在每次创建/启动实例时会刷新 `compose.generated.yaml` 并执行 `docker compose -f compose.yaml -f compose.generated.yaml up -d <service>`。

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
