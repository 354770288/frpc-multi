# 安全说明

本文档记录 `frpc` 多实例部署中的安全边界和注意事项。

## 配置与密钥

`frpc.toml` 中通常包含 `frps` 地址、认证 token、代理端口和本地服务地址。生产环境中应限制配置文件权限：

```bash
chmod 600 /opt/frpc-multi/instances/*/frpc.toml
```

注意事项：

- 不要把生产 token 提交到公开仓库。
- 不要在聊天、工单或截图中暴露完整 token。
- 不同客户或不同用途建议使用不同 token。
- 离职、泄露或迁移后应及时轮换 token。

## 容器安全加固

`compose.yaml` 已设置以下加固项：

- `read_only: true`
- `cap_drop: [ALL]`
- `security_opt: no-new-privileges:true`
- 配置文件只读挂载
- 小尺寸 `/tmp` tmpfs
- 默认不发布容器端口到 VPS

这些配置的目标是降低单个 `frpc` 实例异常时对宿主机的影响。如果未来某个特殊代理场景需要额外权限，应只给对应 service 单独增加，不要放宽全部实例。

## 网络暴露

默认 Docker bridge 模式下，容器不会主动向 VPS 暴露服务端口。`frpc` 的主要行为是主动连接远端 `frps`。

切换到 `network_mode: host` 前，必须检查端口：

```bash
grep -R "remotePort" instances
grep -R "localPort" instances
```

检查重点：

- `remotePort` 在 `frps` 侧不能冲突。
- `localPort` 必须指向预期的本地服务。
- 不要误把数据库、管理后台、内网服务暴露出去。
- VPS 防火墙只放行必要端口。

## 日志安全

容器日志可能包含连接错误、域名、端口和部分路径信息。排查问题时可以查看日志，但不要把完整日志直接公开发布。

查看最近日志：

```bash
docker logs --tail 200 frpc-<instance-name>
```

如需发给他人协助排查，先删除 token、真实域名、IP、客户标识等敏感信息。

## 管理权限

能操作 `/opt/frpc-multi` 和 Docker 的用户，基本等同于能控制所有 `frpc` 实例。建议：

- VPS 只开放必要的 SSH 用户。
- 禁止密码登录，优先使用 SSH key。
- 限制 Docker 组成员。
- 定期更新系统安全补丁。
- 管理平台上线前只允许本机或内网访问。

## Console / Agent 角色边界

只有两种角色，生产部署显式设置：

```text
FRPC_MULTI_ROLE=console
FRPC_MULTI_ROLE=agent
```

连接方向是 **Agent 主动出站连 Console**（WebSocket 长连接 `/ws/agent`），不是 Console 去连 Agent。安全含义：

- Console 节点（`FRPC_MULTI_ROLE=console`）只挂载前端、`/api/*` 和 `/ws/agent`，不挂载 Docker socket，不执行本机 Docker。
- Agent 节点（`FRPC_MULTI_ROLE=agent`）挂载 `/var/run/docker.sock` 管理本机 frpc 实例，但**不监听任何入站管理端口**，因此不存在"Agent 接口裸露公网"的问题——它只发起出站连接。
- Agent 机器无需公网、无需开放端口，NAT / 内网机器也能纳管。需要暴露给 Agent 的只有主控地址。

专用部署文件：

- `compose.console.yaml`：只运行 Console，不挂载 `/var/run/docker.sock`，作为主控入口。
- `compose.agent.yaml`：只运行 Agent，必须挂载 `/var/run/docker.sock`，出站连回主控。

主控的暴露面是 `/ws/agent`（接受 Agent 连接）和 `/api/*` + 前端（用户登录）。把主控暴露到公网时应放在 HTTPS 反代后，并启用 `CONSOLE_TLS=true`。

## Agent 出站鉴权（uuid + secret）

每个节点在 Console 创建时生成一对凭据：

- `uuid`：节点身份标识，绑定到一条节点记录。
- `secret`：出站鉴权密钥，Agent 连回主控时在握手帧里携带，主控用常量时间比对（`hmac.compare_digest`）。

要点：

- secret 仅在创建 / 轮换节点时随响应返回一次，用于展示一键安装命令；列表、详情、ping 响应都不回显 secret。
- secret 泄露或人员变动后，在 Console 节点页"轮换密钥"，旧 secret 立即失效，需用新命令在目标机重装 Agent。
- 不同节点使用各自独立的 secret，不复用。
- 握手失败（uuid 不存在或 secret 不匹配）时主控直接关闭连接（WebSocket close 1008），不泄露原因细节。

## Console 节点凭据存储

Console 把各节点的 `uuid` 和 `secret` 保存在 `/data/console.db`（SQLite）。secret 当前为明文存储，不在前端回显。因此：

- 限制 `/data/console.db`（或对应 Docker volume）的访问权限，按主机管理员级别保护。
- 不要把 `console.db` 提交到仓库或随备份外发。
- secret 泄露或人员变动后，在 Console 节点页轮换密钥，并用新命令重装对应 Agent。

通过域名或反向代理访问 Console 时，用环境变量 `WEBUI_CORS_ORIGINS`（逗号分隔）配置允许的前端来源，默认只允许同源本机访问。反代需放行 `/ws/agent` 的 WebSocket 升级（`Upgrade` / `Connection` 头）。
