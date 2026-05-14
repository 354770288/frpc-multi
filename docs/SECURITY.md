# 安全说明

本文档记录 `frpc` 多实例部署中的安全边界和注意事项。

## 配置与密钥

`frpc.toml` 中通常包含 `frps` 地址、认证 token、代理端口和本地服务地址。生产环境中应限制配置文件权限：

```bash
chmod 600 /opt/frpc-multi/configs/*/frpc.toml
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
grep -R "remotePort" configs
grep -R "localPort" configs
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
docker logs --tail 200 frpc-client-01
```

如需发给他人协助排查，先删除 token、真实域名、IP、客户标识等敏感信息。

## 管理权限

能操作 `/opt/frpc-multi` 和 Docker 的用户，基本等同于能控制所有 `frpc` 实例。建议：

- VPS 只开放必要的 SSH 用户。
- 禁止密码登录，优先使用 SSH key。
- 限制 Docker 组成员。
- 定期更新系统安全补丁。
- 管理平台上线前只允许本机或内网访问。

