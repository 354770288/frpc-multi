# 运维手册

本文档记录 `frpc` 多实例项目在 VPS 上的日常运维流程。默认项目目录为 `/opt/frpc-multi`。

## 上线前检查

- VPS 至少有 2GB RAM，并已开启 1-2GB swap。
- 已安装 Docker Engine 和 Docker Compose plugin。
- `/opt/frpc-multi/.env` 已存在，并固定了明确的 `FRP_IMAGE` 版本。
- `instances/` 目录中已经没有 `CHANGE_ME` 占位符。
- 每个启用实例的 proxy name 唯一。
- 每个启用实例的 remote port 不冲突。
- `bash scripts/check-health.sh` 可以正常执行。
- 升级前已执行过 `bash scripts/backup-configs.sh`。
- Docker 日志轮转仍保留 `max-size` 和 `max-file` 限制。

## 启用每日健康检查

复制 systemd unit：

```bash
sudo cp /opt/frpc-multi/systemd/frpc-multi-health.service /etc/systemd/system/
sudo cp /opt/frpc-multi/systemd/frpc-multi-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frpc-multi-health.timer
```

查看 timer 是否生效：

```bash
systemctl list-timers frpc-multi-health.timer
journalctl -u frpc-multi-health.service -n 100 --no-pager
```

默认 timer 每天运行一次 `scripts/check-health.sh`。如果需要更高频率，可以修改 `systemd/frpc-multi-health.timer` 里的 `OnCalendar`。

## 日常巡检

建议每天或每周至少执行一次（在 Agent 服务器查看 frpc 实例，在主控查看 Console）：

```bash
cd /opt/frpc-multi
free -h
df -h
# Agent 机器：查看 frpc 实例
docker compose -f compose.yaml -f compose.generated.yaml ps
docker stats --no-stream
bash scripts/check-health.sh
```

重点关注：

- 是否有容器反复重启。
- 是否有容器内存持续升高。
- VPS swap 是否长期大量占用。
- 磁盘是否接近写满。
- 某个容器日志是否异常增长。

## Console / Agent 运维（反转模型）

连接方向是 Agent 主动出站连回 Console。Console 不执行本机 Docker，frpc 实例全部跑在各 Agent 上。

主控 Console 服务器：

```bash
cd /opt/frpc-multi
docker compose -f compose.console.yaml ps
docker compose -f compose.console.yaml logs --tail 100 frpc-console
```

`compose.console.yaml` 固定运行 `FRPC_MULTI_ROLE=console`，只提供前端、`/api/*` 和 `/ws/agent`，不挂载 Docker socket。若 `.env` 误写 `FRPC_MULTI_ROLE=all`，后端会自动降级为 console 并在日志告警。

Console 节点数据存储在 `/data/console.db`（Docker volume `frpc-multi-console_console-data`），保存节点的 uuid/secret 与审计日志。切换部署或重建容器时不要用 `docker compose down -v`，否则会删除该 volume。

Agent 执行服务器：

```bash
# Agent 容器本身（含连回主控的状态）
docker logs --tail 100 frpc-agent
# 该机器上的 frpc 实例
cd /opt/frpc-multi
docker compose -f compose.yaml -f compose.generated.yaml ps
```

节点凭据由 Console 生成并通过一键安装命令注入 Agent（`AGENT_UUID` / `AGENT_SECRET`）。轮换密钥：在 Console 节点页点"轮换密钥"，旧 secret 立即失效，然后用新命令在目标机重装 Agent：

```bash
# 在 Agent 机器上，用新一键命令重装（脚本会用新配置重建容器）
docker rm -f frpc-agent
# 粘贴 Console 新生成的一键安装命令
```

## 节点突然为空时的恢复步骤

先不要执行任何带 `-v` 的删除命令，例如 `docker compose down -v` 或 `docker volume rm`。

在主控服务器执行：

```bash
cd /opt/frpc-multi
docker volume ls | grep frpc-multi
docker compose -f compose.console.yaml ps
```

如果看到 `frpc-multi-console_console-data`，先备份旧 Console 数据库：

```bash
mkdir -p backups
docker run --rm \
  -v frpc-multi-console_console-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine sh -c 'cp /data/console.db /backup/console-db-$(date +%Y%m%d-%H%M%S).db'
```

然后拉取最新代码并重启主控：

```bash
git pull origin main
docker compose -f compose.console.yaml up -d --build
```

确认容器读到同一个数据库：

```bash
docker exec frpc-console sh -c 'ls -lh /data/console.db'
```

## Console / Agent 联调验收

以下步骤用于确认反转模型在真实环境跑通。

### 1. 部署主控并添加节点

- 按 README 部署 Console，确认 `.env` 里 `CONSOLE_PUBLIC_HOST` 填了 Agent 能访问到的主控地址。
- 登录面板，进入"节点"，新建节点（例如 `agent-01`），复制生成的一键安装命令。

### 2. 在目标机器安装 Agent

在 Agent 服务器粘贴运行一键命令，然后看日志：

```bash
docker logs -f frpc-agent
# 期望看到："已连接主控 ws://... （节点：agent-01）"
```

回到面板，节点状态应从"待连接"变为"在线"。若一直重连，检查目标机能否出站访问 `AGENT_SERVER`，以及 uuid/secret 是否与面板一致。

### 3. 验证远程实例创建

在 Console"创建实例"：节点选 `agent-01`，实例名用临时名（如 `client-smoke-001`），填测试用 `serverAddr` / `serverPort`，首次先关闭"创建后启动"。

在 Agent 服务器确认：

```bash
cd /opt/frpc-multi
test -f instances/client-smoke-001/frpc.toml
grep -n "frpc-client-smoke-001" compose.generated.yaml
docker compose -f compose.yaml -f compose.generated.yaml config >/tmp/frpc-agent-generated-check.yaml
```

预期：配置文件存在、`compose.generated.yaml` 有对应 service、Compose 配置检查无报错。

### 4. 验证远程实例操作

在 Console 页面执行启动、查看详情和日志（含实时跟随）、修改配置并保存、停止、重启或重建。Agent 服务器辅助确认：

```bash
cd /opt/frpc-multi
docker compose -f compose.yaml -f compose.generated.yaml ps
docker logs --tail 100 frpc-client-smoke-001
```

### 5. 验证审计日志

在 Console"审计"页应看到创建、修改配置、启停、重启、重建、删除记录；每条带对应节点 ID 和操作人；失败操作也记录为失败。

### 6. 清理临时实例

在 Console 删除 `client-smoke-001`，随后在 Agent 服务器确认：

```bash
cd /opt/frpc-multi
test ! -d instances/client-smoke-001
! grep -q "frpc-client-smoke-001" compose.generated.yaml
bash scripts/check-health.sh
```

## 内存异常处理

如果发现某个容器内存异常增长：

```bash
cd /opt/frpc-multi
docker stats --no-stream
docker logs --tail 200 frpc-<instance-name>
bash scripts/restart-one.sh <instance-name>
```

如果同一个实例反复出现内存异常：

- 保留容器内存限制，不要先取消限制。
- 检查该实例代理数量是否过多。
- 检查对应本地服务是否连接异常。
- 检查 `frps` 服务端是否稳定。
- 检查网络质量和连接重试情况。
- 尝试升级到新的固定 frp 镜像版本。
- 如果升级后更差，立即回滚 `.env` 中的 `FRP_IMAGE`。

## 配置变更流程

推荐通过 WebUI 编辑配置，并在保存时勾选"保存后重新创建容器"。如果需要在命令行手动操作，一次只改一个实例：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
nano instances/<instance-name>/frpc.toml
docker compose -f compose.yaml -f compose.generated.yaml up -d --no-deps --force-recreate frpc-<instance-name>
bash scripts/check-health.sh
```

如果修改后实例异常，优先回滚刚刚备份的配置，而不是同时修改多个实例。

## 长稳测试

首次上线后的 7 天建议记录以下信息：

```bash
date
free -h
df -h
docker compose -f compose.yaml -f compose.generated.yaml ps
docker stats --no-stream
```

如果出现以下情况，需要立即排查：

- 某个实例重启次数持续增加。
- 内存曲线每天持续上升。
- swap 长期占用很高。
- 日志增长速度异常。
- VPS load 持续高于 CPU 核心数。

## 备份与恢复

创建配置备份：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
```

备份文件默认保存在：

```text
/opt/frpc-multi/backups/
```

恢复时先停止相关实例，解压备份覆盖配置，再重建容器：

```bash
cd /opt/frpc-multi
docker compose -f compose.yaml -f compose.generated.yaml stop frpc-<instance-name>
tar -xzf backups/frpc-multi-configs-YYYYMMDD-HHMMSS.tar.gz
docker compose -f compose.yaml -f compose.generated.yaml up -d --no-deps --force-recreate frpc-<instance-name>
```
