# frpc WebUI 管理面板

WebUI 是 frpc 多实例管理面板，用于动态创建、编辑、启动、停止和删除 `frpc` 实例。每个实例对应 `instances/<name>/frpc.toml` 一份配置。面板由主控 Console 托管；实例操作通过 WebSocket 下发到对应 Agent，由 Agent 在本机写入 `compose.generated.yaml` 并调用 Docker Compose 执行。

## 架构

- Console（主控）：托管前端 + `/api/*` + `/ws/agent`，不挂载 Docker socket，不执行本机 Docker。
- Agent（执行端）：主动出站连回 Console，挂载 Docker socket，管理本机 `instances/` 和 `compose.generated.yaml`。

连接方向是 Agent 主动连 Console，因此 Agent 机器无需公网、无需开放入站端口。详见仓库根目录 README 与 `docs/AGENT_INSTALL.md`。

## 默认访问

Console 默认绑定到宿主机本机地址：

```text
127.0.0.1:8081
```

在 VPS 上访问推荐先用 SSH 隧道：

```bash
ssh -L 8081:127.0.0.1:8081 root@你的VPS_IP
```

浏览器打开 `http://127.0.0.1:8081`。公网访问、HTTPS 和反向代理由使用者自行配置；反代需放行 `/ws/agent` 的 WebSocket 升级。

## 启动 Console

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env   # 至少设置 WEBUI_PASSWORD、CONSOLE_PUBLIC_HOST
docker compose -f compose.console.yaml up -d --build
```

`compose.console.yaml` 固定运行 `FRPC_MULTI_ROLE=console`，只提供前端、`/api/*` 和 `/ws/agent`，不挂载 Docker socket。`.env` 误写 `FRPC_MULTI_ROLE=all` 会自动降级为 console 并在日志告警。

Console 节点数据库固定为 `/data/console.db`（Docker volume `frpc-multi-console_console-data`），保存节点 uuid/secret 和审计。切换部署或重建时不要用 `down -v`，否则会删除 volume。

## 添加节点 / 部署 Agent

不再手填地址和 token：

1. 在 Console"节点"页输入节点名称，点"创建节点"。
2. 复制弹出的一键安装命令（含该节点的 uuid + secret）。
3. 在目标机器运行该命令，Agent 会拉镜像、启动并主动连回主控。
4. 节点变为"在线"后即可为它创建和管理实例。

实例的创建、配置、启停、删除都通过 `nodeId + instanceName` 路径下发到对应 Agent。关键变更写入"审计"页，带对应节点 ID 和操作人；失败操作也记录为失败。

主控自身要跑 frpc 时，同样新建一个节点、在主控机上运行一键命令装一个 Agent。详见 `docs/AGENT_INSTALL.md`。

## 命令行排查

实例容器跑在 Agent 机器上，需要时在该机器执行：

```bash
cd /opt/frpc-multi
docker logs -f frpc-agent                                        # Agent 连回主控的状态
docker compose -f compose.yaml -f compose.generated.yaml ps      # 本机 frpc 实例
docker logs --tail 200 frpc-<instance-name>                      # 单个实例日志
```
