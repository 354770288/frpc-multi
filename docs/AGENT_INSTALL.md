# Agent 安装说明

本文档说明如何把一台机器纳管为 frpc 执行节点（Agent）。反转连接模型下，Agent 主动出站连回主控 Console，因此目标机器**无需公网 IP、无需开放任何入站端口**，只要能访问到主控即可。

## 前置条件

- 目标机器已安装 Docker（可用 `scripts/install-docker-debian-ubuntu.sh`）。
- 目标机器能出站访问主控地址（主控的 `CONSOLE_PUBLIC_HOST`，如 `frpc.example.com:8081`）。
- 主控 Console 已部署并可登录（见 README 的"部署主控 Console"）。

## 一键安装（推荐）

1. 登录 Console，进入"节点"页。
2. 输入节点名称（如 `vps-hk-01`），点"创建节点"。
3. 页面弹出该节点专属的一键安装命令，形如：

   ```bash
   docker run -d --name frpc-agent --restart unless-stopped \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v frpc-agent-data:/opt/frpc-multi \
     -e FRPC_MULTI_ROLE=agent \
     -e AGENT_SERVER=frpc.example.com:8081 \
     -e AGENT_UUID=<自动生成> \
     -e AGENT_SECRET=<自动生成> \
     -e AGENT_TLS=false \
     ghcr.io/354770288/frpc-multi:latest
   ```

4. 复制命令，在目标机器上以 root（或有 docker 权限的用户）运行。
5. 几秒后回到 Console，节点状态会从"待连接"变为"在线"。

命令里的 `AGENT_UUID` 是节点身份，`AGENT_SECRET` 是出站鉴权密钥，二者由主控生成并绑定到这条节点记录。Agent 启动后用它们连回 `/ws/agent` 完成握手。

## 使用安装脚本

如果主控配置了 `AGENT_INSTALL_URL`，一键命令会改为下载并执行 `scripts/install-agent.sh`。也可以手动用脚本：

```bash
AGENT_SERVER=frpc.example.com:8081 \
AGENT_UUID=<从面板复制> \
AGENT_SECRET=<从面板复制> \
AGENT_TLS=false \
bash scripts/install-agent.sh
```

脚本会拉取镜像、清理同名旧容器、用新配置启动 `frpc-agent`。可选环境变量：

- `AGENT_IMAGE`：镜像，默认 `ghcr.io/354770288/frpc-multi:latest`。
- `AGENT_DATA_DIR`：持久化目录，默认 `/opt/frpc-multi`。
- `AGENT_CONTAINER`：容器名，默认 `frpc-agent`。

## 使用 compose.agent.yaml

偏好 compose 的话，在目标机器上：

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env   # 填 AGENT_SERVER / AGENT_UUID / AGENT_SECRET / AGENT_TLS
docker compose -f compose.agent.yaml up -d --build
```

## 主控自身作为节点

主控机器要跑 frpc 实例时，没有特殊模式：在 Console 新建一个节点（如 `console-local`），把生成的一键命令在主控机上运行即可。此时 `AGENT_SERVER` 可以填主控的本机可达地址（如 `127.0.0.1:8081`，前提是 Agent 容器能访问到——通常用主机网络或主控的内网地址）。

## TLS / 反向代理

主控放在 HTTPS 反代后时：

- 主控 `.env` 设 `CONSOLE_TLS=true`，一键命令会带 `AGENT_TLS=true`，Agent 用 `wss` 连接。
- 反代需放行 WebSocket 升级（`/ws/agent` 路径的 `Upgrade` / `Connection` 头）。

## 验证与排查

```bash
# 查看 Agent 连回主控的状态
docker logs -f frpc-agent
# 期望看到："已连接主控 ws://... （节点：<名称>）"
```

- 一直重连：检查目标机能否访问 `AGENT_SERVER`（`curl -v telnet://host:port` 或 `nc -vz host port`），以及 uuid/secret 是否与面板一致。
- 握手被拒（鉴权失败）：多半是 secret 不匹配。可在面板对该节点"轮换密钥"，用新命令重装。
- 节点显示在线但实例操作失败：检查 Agent 机器的 docker.sock 是否挂载、docker 是否可用。

## 轮换密钥 / 删除节点

- 轮换密钥：面板节点行点"轮换密钥"，旧密钥立即失效，需用新命令在目标机重装 Agent。
- 删除节点：面板删除后，到目标机 `docker rm -f frpc-agent` 停掉 Agent。已有的 `instances/` 配置不会被删除。
