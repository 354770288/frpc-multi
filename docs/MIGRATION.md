# 从旧架构迁移到反转模型

本文档面向**已经在用旧版本**的部署：旧版有 `all` 单机模式，且节点是"Console 通过 HTTP 主动连 Agent"（节点要手填地址 + `AGENT_TOKEN`）。新版本改为反转模型：**Agent 主动出站连回 Console**，节点用 uuid + secret + 一键安装命令。本文给出平滑迁移步骤，已有的 `instances/` 配置全程保留。

如果你是全新部署，不用看本文，直接按 README 部署主控、按 `docs/AGENT_INSTALL.md` 加节点即可。

## 变化对照

| 维度 | 旧架构 | 新架构（反转） |
| --- | --- | --- |
| 角色 | `all` / `console` / `agent` | 只有 `console` / `agent`（`all` 自动降级为 `console`） |
| 连接方向 | Console 主动 HTTP 连 Agent | Agent 主动 WS 连回 Console |
| Agent 暴露 | 监听 `127.0.0.1:8082`，需对 Console 可达（VPN/隧道） | 不监听入站端口，只需能出站访问主控 |
| 加节点 | 手填 Agent 地址 + `AGENT_TOKEN` | 面板生成 uuid + secret + 一键安装命令 |
| 节点凭据 | `AGENT_TOKEN`（bearer） | `AGENT_UUID` + `AGENT_SECRET`（握手鉴权） |

数据库会自动迁移：旧 `nodes` 表的 `base_url` / `token` 列保留不动，新版补充 `uuid` / `secret` 列。但旧节点记录的 uuid/secret 为空，**无法在新模型下连接**，需要按下面步骤重新创建节点。

## 第 0 步：备份

在涉及的每台机器上先备份：

```bash
cd /opt/frpc-multi
bash scripts/backup-configs.sh
```

注意：切换部署时不要用 `docker compose down -v`，否则会删除保存节点和审计的 `/data` volume。

## 第 1 步：升级并重启主控为 console 角色

```bash
cd /opt/frpc-multi
rsync -av /path/to/new/code/ ./      # 或 git pull
cp .env.example .env.new             # 对照新变量，合并到你的 .env
nano .env                            # 见下方"环境变量调整"
docker compose -f compose.console.yaml up -d --build
```

环境变量调整：

- 删除 / 忽略：`AGENT_AUTH_ENABLED`、`AGENT_TOKEN`（旧 bearer 机制已取消）。
- `FRPC_MULTI_ROLE`：设为 `console`（写 `all` 也会自动降级为 console，并在日志告警）。
- 新增 `CONSOLE_PUBLIC_HOST`：填 Agent 能访问到的主控地址 `host:port`（如 `1.2.3.4:8081`）。这是一键安装命令的关键。
- 反代 + TLS 时设 `CONSOLE_TLS=true`，并放行 `/ws/agent` 的 WebSocket 升级。

主控起来后，登录面板，旧节点会显示为离线（因为它们还没有 uuid/secret，且旧 Agent 仍是 HTTP 模式）。

## 第 2 步：把每台旧 Agent 机器切换为出站 Agent

对每台原来的 frpc 服务器：

1. 在 Console 面板"节点"页**新建一个节点**（可沿用原名字），复制生成的一键安装命令。
2. 登录该机器，停掉旧的 HTTP 模式 Agent：

   ```bash
   cd /opt/frpc-multi
   docker compose -f compose.agent.yaml down   # 不要带 -v
   ```

3. 升级代码（`rsync` / `git pull`），然后运行第 1 步复制的一键安装命令。新 Agent 会出站连回主控。
4. 面板上新节点变为"在线"。

由于 `instances/<name>/frpc.toml` 是实例配置的真实来源，新 Agent 启动后会直接复用本机已有的这些文件，不需要重新创建实例。

## 第 3 步：清理旧节点记录

旧的节点记录（带 base_url/token、uuid 为空）已无用，在面板删除它们即可。删除节点不会动 `instances/` 配置。

## 第 4 步：验证

- 总览页能看到各节点上已有的实例（来自各 Agent 的 `instances/`）。
- 在某节点创建一个测试实例，确认写入的是对应 Agent 机器的 `instances/`。
- 启停只影响目标节点。
- 实例详情页可查看日志；打开"实时跟随"可看到节点实例的实时日志流（经 WebSocket 转发）。
- 系统页"节点系统信息"能看到各节点的 Docker 版本、frpc 镜像和磁盘。
- 任意创建/配置/启停/删除操作都会写入"审计"页；失败操作也记录为失败。

## 原 all 单机怎么办

旧的 all 模式 = 一台机器既当主控又跑 frpc。新模型没有这个特殊模式，等价做法是：

1. 这台机器以 `console` 角色运行（`compose.console.yaml`）。
2. 在面板为它新建一个节点（如 `console-local`），在**同一台机器**上运行一键安装命令装一个 Agent。
3. 原来的本机实例由这个本机 Agent 接管（复用 `instances/`）。

`AGENT_SERVER` 填主控的本机可达地址；注意 Agent 跑在容器里，要确保它能访问到主控端口（用主机网络或主控的内网/宿主地址，而非容器内的 `127.0.0.1`）。

## 回滚

如果需要回到旧版本：在主控和各 Agent 机器上切回旧代码与旧 compose 即可。数据库的新增列（uuid/secret）对旧代码无影响（旧代码不读这两列）。但旧代码需要节点的 base_url/token 才能工作，所以回滚后仍要按旧方式重新填节点地址和 token。建议迁移前用第 0 步的备份留底。
