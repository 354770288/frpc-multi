# 运维手册

本文档记录 `frpc` 多实例项目在 VPS 上的日常运维流程。默认项目目录为 `/opt/frpc-multi`。

## 上线前检查

- VPS 至少有 2GB RAM，并已开启 1-2GB swap。
- 已安装 Docker Engine 和 Docker Compose plugin。
- `/opt/frpc-multi/.env` 已存在，并固定了明确的 `FRP_IMAGE` 版本。
- `configs/` 目录中已经没有 `CHANGE_ME` 占位符。
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

## 内存异常处理

如果发现某个容器内存异常增长：

```bash
cd /opt/frpc-multi
docker stats --no-stream
docker logs --tail 200 frpc-client-01
bash scripts/restart-one.sh client-01
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

一次只改一个实例，方便定位问题：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
nano configs/client-01/frpc.toml
docker compose up -d --no-deps --force-recreate frpc-client-01
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
docker compose stop frpc-client-01
tar -xzf backups/frpc-multi-configs-YYYYMMDD-HHMMSS.tar.gz
docker compose up -d --no-deps --force-recreate frpc-client-01
```

