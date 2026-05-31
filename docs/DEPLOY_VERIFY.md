# VPS 部署与验证（Docker Compose / GHCR 镜像）

本文用 Docker Compose + 已发布到 GHCR 的镜像，在 VPS 上部署并验证反转架构。console / agent 是同一个镜像，靠 `FRPC_MULTI_ROLE` 区分：

```text
ghcr.io/354770288/frpc-multi:latest
```

`compose.console.yaml` / `compose.agent.yaml` 已默认 `image:` 指向该镜像，因此**目标机只需要 compose 文件 + .env，不需要整套源码**（也保留了 `build:`，加 `--build` 即本地构建）。

## 0. 前提

- 目标机器已装 Docker 与 Compose 插件。
- 想清楚主控的对外地址：反转模型核心是 **Agent 主动连主控**，主控端口必须对 Agent 可达。
- GHCR 包已是 Public（你已发布）。若是 Private，目标机需先 `docker login ghcr.io`。

## 1. 准备主控部署文件

主控机器上建个目录，只放需要的文件（不用 clone 整个仓库）：

```bash
mkdir -p /opt/frpc-multi && cd /opt/frpc-multi
# 拷入 compose.console.yaml 和 .env.example（从仓库取，或 scp/rsync 过来）
cp .env.example .env
nano .env
```

`.env` 至少改这几项：

```bash
WEBUI_PASSWORD=改成你的强密码
# 让 Agent 能连到主控（验证场景）。仅本机用可改回 127.0.0.1。
CONSOLE_HOST=0.0.0.0
CONSOLE_PORT=8081
# Agent 能访问到的主控地址 host:port，会原样写进面板的一键命令。务必填真实可达地址，别填 127.0.0.1。
CONSOLE_PUBLIC_HOST=<主控IP或域名>:8081
# 套了 HTTPS 反代才设 true（命令用 wss）；裸 HTTP 验证用 false。
CONSOLE_TLS=false
```

启动主控：

```bash
docker compose -f compose.console.yaml up -d
docker compose -f compose.console.yaml logs -f frpc-console
```

> Compose 会自动 `pull` GHCR 镜像。要强制最新：`docker compose -f compose.console.yaml pull` 后再 `up -d`。

⚠️ 安全：`CONSOLE_HOST=0.0.0.0` 把 `/api/*`（登录保护）和 `/ws/agent`（uuid+secret 校验）暴露到公网。验证期用防火墙只放行你的 IP 和 Agent IP；生产套 HTTPS 反代 + `CONSOLE_TLS=true`，反代放行 `/ws/agent` 的 WebSocket 升级。

## 2. 访问面板

```bash
# 本机执行，SSH 隧道更安全
ssh -L 8081:127.0.0.1:8081 root@<主控IP>
# 浏览器开 http://127.0.0.1:8081，admin + 你设的密码
```

## 3. 添加节点 → 拿一键命令

进"节点"页 → 输名称（如 `vps-test`）→ "创建节点"。面板弹出该节点专属的 uuid、secret 和一条 `docker run` 一键命令。

这里有两种 Agent 部署方式，任选：

- **A. 一键 docker run**（面板直接给的命令，最快）：复制粘贴到目标机运行。
- **B. Compose**（你偏好的方式）：只需从面板复制 **uuid 和 secret**，按下一步用 compose 起 Agent。

## 4. 用 Compose 部署 Agent（推荐）

在 Agent 机器上建目录，放 `compose.agent.yaml`，写 `.env`：

```bash
mkdir -p /opt/frpc-multi && cd /opt/frpc-multi
# 拷入 compose.agent.yaml
cat > .env <<'EOF'
AGENT_SERVER=<主控IP>:8081
AGENT_UUID=<从面板复制>
AGENT_SECRET=<从面板复制>
AGENT_TLS=false
EOF

docker compose -f compose.agent.yaml up -d
docker compose -f compose.agent.yaml logs -f frpc-agent
# 期望出现：已连接主控 ws://<主控IP>:8081/ws/agent（节点：vps-test）
```

注意：

- **同一台 VPS 验证**：`AGENT_SERVER` 要填这台机器的 LAN/公网 IP，**不能用 `127.0.0.1`**（那是 Agent 容器自己的 loopback，到不了主控）。
- `compose.agent.yaml` 挂了 `./:/opt/frpc-multi` 和 docker.sock。实例配置 `instances/`、生成的 `compose.yaml` / `compose.generated.yaml` 都落在这个目录，重启不丢。

回面板，节点状态从"待连接"变"在线"。

## 5. 验证清单

| 项 | 操作 | 预期 |
| --- | --- | --- |
| 节点上线 | 看面板节点状态 | "在线"，Agent 日志无重连循环 |
| 创建实例 | "创建实例"页选 `vps-test`，建测试实例（先不勾"创建后启动"）| Agent 机器 `/opt/frpc-multi/instances/<名>/frpc.toml` 生成 |
| base compose 自举 | 看 Agent 目录 | `compose.yaml` 和 `compose.generated.yaml` 已自动生成 |
| 启停 | 面板启动/停止/重启 | `docker ps` 看到 `frpc-<名>` 容器状态变化 |
| 实时日志 | 实例详情页开"实时跟随" | 看到日志流（验证 WebSocket 流式 RPC）|
| 系统信息 | 系统页"节点系统信息" | 显示该节点 Docker 版本/磁盘 |
| 审计 | 审计页 | 看到上述操作，带节点 ID + 操作人；失败也记录 |
| 断线恢复 | `docker compose -f compose.agent.yaml stop` 再 `start` | 面板先转"离线"，几秒后自动重连 |
| 轮换密钥 | 面板"轮换密钥" | 旧 Agent 掉线；用新 secret 更新 `.env` 重启才能再连 |

Agent 机器辅助确认：

```bash
cd /opt/frpc-multi
ls instances/
cat compose.generated.yaml
docker compose -f compose.yaml -f compose.generated.yaml ps
```

## 6. 主控自身也要跑 frpc 实例

反转模型没有"单机模式"。主控机要跑 frpc 时，在面板再建一个节点（如 `console-local`），在主控机上**另起一个 agent**（用上面第 4 步同样的 compose，目录用 `/opt/frpc-multi-agent` 之类与 console 分开），`AGENT_SERVER` 填主控的可达地址。

## 7. 升级

```bash
# 主控
cd /opt/frpc-multi
docker compose -f compose.console.yaml pull
docker compose -f compose.console.yaml up -d

# Agent
cd /opt/frpc-multi
docker compose -f compose.agent.yaml pull
docker compose -f compose.agent.yaml up -d
```

数据在挂载的宿主目录（默认 `/opt/frpc-multi`）里，升级不丢。

## 8. 常见问题

- **Agent 一直重连**：`nc -vz <主控IP> 8081` 测连通；主控是否 `0.0.0.0` + 防火墙放行；uuid/secret 是否与面板一致。
- **节点在线但实例操作失败**：Agent 是否挂了 docker.sock（`docker compose -f compose.agent.yaml exec frpc-agent docker ps`）。
- **`pull` 拉不到镜像**：确认 GHCR 包 Public；否则先 `docker login ghcr.io`。
- **同机 Agent 连不上**：`AGENT_SERVER` 写成了 `127.0.0.1`，改成本机 LAN/公网 IP。
- **创建实例报 compose 相关错误**：旧镜像缺 base compose 自举逻辑。确认拉的是最新镜像（含本次修复），Agent 启动日志应无"初始化工作目录失败"。
- **frpc 实例日志报 `read /etc/frp/frpc.toml: is a directory`**：docker-out-of-docker 路径不对齐。Agent 经宿主 docker.sock 创建 frpc 容器，frpc 的配置 bind mount 由宿主机文件系统解析，所以 Agent 的数据目录必须"宿主路径 = 容器内路径"。① 不要用 named volume（如 `-v frpc-agent-data:/opt/frpc-multi`），要用 `-v /opt/frpc-multi:/opt/frpc-multi`；② `PROJECT_DIR` 要等于这个挂载的宿主路径。用最新的一键命令/`compose.agent.yaml`/`install-agent.sh` 即已对齐；老命令需删掉 Agent 容器用新命令重装。
- **系统页"节点系统信息"无 frpc 镜像/版本**：远程 Agent 用一键 `docker run` 装、没有 `.env` 文件，旧版读不到 `FRP_IMAGE`。最新镜像已让 Agent 优先读环境变量，且一键命令/脚本/`compose.agent.yaml` 都会注入 `FRP_IMAGE`。确认拉的是最新镜像、且启动命令带 `-e FRP_IMAGE=...`（面板生成的最新命令已含）。注意：主控自带的源码挂载 Agent 因有 `.env.example` 一直能读到，这是正常差异。
- **实例详情页"实时跟随"报连接失败 / "暂无日志或 Docker 未连接"**：多为 frpc 容器没真正起来（常因上面的镜像/路径问题），或该实例未启动。先确认实例已 start、`docker ps` 能看到 `frpc-<name>` 容器；再开实时跟随。
- **删除节点后 Agent 容器还在**：删节点会让 Agent 停删所有实例 + 删配置 + 自毁容器（`docker rm -f $HOSTNAME`）。自毁在极端情况下可能不成功（权限/时序），此时 Agent 已停止连回主控、不会变幽灵节点，但容器壳可能残留。到该机器 `docker ps -a | grep frpc-agent` 确认，残留则手动 `docker rm -f frpc-agent`。实例容器和配置目录此时已被清理。
- **节点离线时删除**：无法远程清理，只删主控的节点记录并返回提示。需自行登录该机器 `docker rm -f frpc-agent` 并清理 `instances/` 目录。
