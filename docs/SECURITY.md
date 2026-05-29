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

生产分离部署时应显式设置运行角色：

```text
FRPC_MULTI_ROLE=console
FRPC_MULTI_ROLE=agent
```

建议：

- Console 节点使用 `FRPC_MULTI_ROLE=console`，只挂载 `/api/*` 和前端，不挂载 Docker socket。
- Agent 节点使用 `FRPC_MULTI_ROLE=agent`，只挂载 `/agent/*`，并且只在内网、VPN、Tailscale、WireGuard 或 HTTPS 反向代理后暴露。
- 兼容单机部署可以继续使用默认 `FRPC_MULTI_ROLE=all`，但这不是生产分离部署的推荐值。
- Agent 生产部署必须设置 `AGENT_AUTH_ENABLED=true` 和高强度 `AGENT_TOKEN`。
- Console 访问 Agent 时使用 `Authorization: Bearer <AGENT_TOKEN>`，不要把 Agent token 暴露给浏览器或前端构建产物。

专用部署文件：

- `compose.console.yaml`：只运行 Console，不挂载 `/var/run/docker.sock`，适合作为主控入口。
- `compose.agent.yaml`：只运行 Agent，必须挂载 `/var/run/docker.sock`，只应部署在需要管理本机 frpc 实例的服务器上。

Agent 默认绑定 `127.0.0.1:8082`。如果需要跨机器访问，应优先通过私有网络或受控隧道暴露，不建议直接改成 `0.0.0.0` 后裸露到公网。
