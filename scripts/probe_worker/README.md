# 测试节点安装与升级

测试节点主动出站访问 Console，支持 IPv4 网段发现、mtr 去程路由、frps 穿透连通性和双隧道上下行速率测试。多个节点各自执行完整目标集，观测按节点和目标端口保存。测试节点与管理 frpc 实例的 Agent 使用独立身份和权限。

## 安装

在面板「测试节点」创建节点，复制只显示一次的安装命令，在 Debian/Ubuntu 的 amd64 或 arm64 服务器上执行。命令会传入 Console 地址和节点 Token。安装器安装 Python、mtr 和固定版本 frpc，并校验 Console 下发的程序包 SHA256。

程序：`/opt/frpc-probe/versions/`，当前版本：`/opt/frpc-probe/current`。配置：`/etc/frpc-probe/worker.env`，权限 `0600`。服务：`frpc-probe.service`。节点仅需能出站访问 Console 和被测目标。

## 升级现有路由节点

以下命令分两步执行。安装器会读取现有 `frpc-route.service` 的环境变量或已有 env 文件，保留 URL 和 Token；新程序准备完成后停止旧服务并启动增强后的服务。

```bash
curl -fsSL http://23.19.228.204:8081/api/probe/worker/install.sh -o /tmp/frpc-probe-install.sh
sudo bash /tmp/frpc-probe-install.sh
```

仓库内 `install.sh` 是指向后端安装器的符号链接。对远程机器使用上面的 Console 下载入口，确保程序包和安装器来自同一部署版本。

```bash
systemctl status frpc-probe
journalctl -u frpc-probe -n 50
```

面板确认节点名称、版本、在线状态及四项能力。旧节点未升级时仍支持路由测试。

若节点下载 GitHub 发布包受限，可先将官方 `frp_0.68.1_linux_amd64.tar.gz`（arm64 节点使用对应包）传到节点，再执行 `sudo env FRPC_ARCHIVE=/path/to/frp.tar.gz bash /tmp/frpc-probe-install.sh`。安装器会使用明确指定的本地归档并校验二进制版本；普通安装继续从官方发布地址下载。

## 任务与结果

- 创建任务时明确选择节点，后续阶段固定在该节点运行。节点离线时任务等待该节点恢复。
- 「完整测试」执行路由、穿透，再对穿透全部通过的目标测速；路由失败仍继续穿透。
- 网段扫描可选发现后自动路由或自动完整测试，发现结果导入服务器库仍由用户操作。
- 节点默认每 10 秒心跳；任务租约 120 秒，90 秒未续租会中止本机测试并清理资源。基础设施故障最多执行三次，目标测试失败保留结果。
- 同一 frps 的穿透测试跨节点互斥；节点测速期间暂停其其他网络任务，降低结果之间的干扰。
- 列表、历史、统计按所选观测节点读取。速率表示该执行节点经目标 frps 的隧道传输表现。

## 回滚

升级已有增强节点时安装器保留 `/opt/frpc-probe/previous`。停止服务，将 `current` 指向 `previous` 所示的旧目录，再启动服务；配置和身份继续保留。

首次从旧路由节点升级时，原 `/opt/frpc-route` 与 systemd 配置仍保留。需要回退时先停止 `frpc-probe`，再启用并启动 `frpc-route`。

## 负载均衡

面板全局选择一个稳定的国内观测节点提供排序数据，主控负责健康检查。默认采用最近 24 小时的记录；记录缺失或过期时保留健康当前 IP，当前 IP 故障仍可根据主控健康状态切换。穿透和测速由手动或扫描流程触发。
