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

建议每天或每周至少执行一次：

```bash
cd /opt/frpc-multi
free -h
df -h
docker compose ps
docker stats --no-stream
bash scripts/check-health.sh
```

重点关注：

- 是否有容器反复重启。
- 是否有容器内存持续升高。
- VPS swap 是否长期大量占用。
- 磁盘是否接近写满。
- 某个容器日志是否异常增长。

## Console / Agent 分离部署运维

单机兼容部署继续使用默认 compose：

```bash
cd /opt/frpc-multi
docker compose ps
```

Console 主控服务器使用：

```bash
cd /opt/frpc-multi
docker compose -f compose.console.yaml ps
docker compose -f compose.console.yaml logs --tail 100 frpc-console
```

`compose.console.yaml` 固定运行 `FRPC_MULTI_ROLE=console`。即使 `.env` 中写了 `FRPC_MULTI_ROLE=all`，该容器也只提供前端和 Console API，不会启动本机 Agent API，也不会监听 `8082`。需要 all-in-one 单机模式时使用默认 `compose.yaml`；需要 Agent 能力时在执行服务器启动 `compose.agent.yaml`。

Agent 执行服务器使用：

```bash
cd /opt/frpc-multi
docker compose -f compose.agent.yaml ps
docker compose -f compose.agent.yaml logs --tail 100 frpc-agent
docker compose -f compose.generated.yaml ps
```

Agent 的 `.env` 必须设置 `AGENT_TOKEN`，Console 节点页面中保存的 token 要与对应 Agent 一致。轮换 token 时，先更新 Agent `.env` 并重启 Agent，再到 Console 节点页面更新该节点 token 并执行测试连接。

```bash
cd /opt/frpc-multi
nano .env
docker compose -f compose.agent.yaml up -d
```

## Console / Agent 联调验收

以下步骤用于确认前后端分离和 Console / Agent 分离部署已经在真实环境跑通。

### 1. 验证 Agent 自身可用

在 Agent 服务器执行：

```bash
cd /opt/frpc-multi
grep -E '^AGENT_TOKEN=' .env
docker compose -f compose.agent.yaml ps
curl -fsS -H "Authorization: Bearer $(grep '^AGENT_TOKEN=' .env | cut -d= -f2-)" http://127.0.0.1:8082/agent/health
```

预期返回：

```json
{"ok":true}
```

如果 Console 与 Agent 不在同一台机器，还需要在 Console 服务器或你的本机验证 Agent 的可访问地址：

```bash
curl -fsS -H "Authorization: Bearer <AGENT_TOKEN>" http://<agent-address>:8082/agent/health
```

`<agent-address>` 应是内网、VPN、Tailscale、WireGuard、Cloudflare Tunnel 或 HTTPS 反向代理地址，不建议裸公网 HTTP。

### 2. 验证 Console 节点管理

在 Console 页面中进入“节点”：

- 新增节点，名称例如 `agent-01`。
- Agent 地址填写第 1 步验证过的可访问地址，例如 `http://10.0.0.12:8082`。
- Token 填写该 Agent 的 `AGENT_TOKEN`。
- 点击“测试”，预期节点状态变为“在线”。

Console 服务器可同时查看日志：

```bash
cd /opt/frpc-multi
docker compose -f compose.console.yaml logs --tail 100 frpc-console
```

### 3. 验证远程实例创建

在 Console 页面中进入“创建实例”：

- 节点选择刚新增的 `agent-01`。
- 实例名使用临时名称，例如 `client-smoke-001`。
- 填写一个可用于测试的 `serverAddr` 和 `serverPort`。
- 首次验收建议先关闭“创建后启动”，先验证文件和 compose 生成。

在 Agent 服务器执行：

```bash
cd /opt/frpc-multi
test -f instances/client-smoke-001/frpc.toml
grep -n "frpc-client-smoke-001" compose.generated.yaml
docker compose -f compose.generated.yaml config >/tmp/frpc-agent-generated-check.yaml
```

预期：实例配置文件存在，`compose.generated.yaml` 中存在对应 service，Compose 配置检查无报错。

### 4. 验证远程实例操作

如果测试配置能连接真实 `frps`，在 Console 页面执行：

- 启动实例。
- 查看详情和日志。
- 修改配置并保存。
- 停止实例。
- 重启或重建实例。

在 Agent 服务器辅助确认：

```bash
cd /opt/frpc-multi
docker compose -f compose.generated.yaml ps
docker logs --tail 100 frpc-client-smoke-001
```

如果测试配置只是占位配置，不建议长期启动；启动失败时重点看 Console 是否返回明确错误、Agent 日志是否可解释。

### 5. 验证审计日志

在 Console 页面进入“审计”：

- 应能看到创建、修改配置、启动、停止、重启、重建、删除等操作记录。
- 远程 Agent 操作应显示对应节点 ID；单机兼容路径操作显示“本机”。
- 操作人应为当前登录用户名。

### 6. 清理临时实例

验收结束后在 Console 删除 `client-smoke-001`。随后在 Agent 服务器确认：

```bash
cd /opt/frpc-multi
test ! -d instances/client-smoke-001
! grep -q "frpc-client-smoke-001" compose.generated.yaml
```

最后再跑一次：

```bash
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
docker compose ps
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
