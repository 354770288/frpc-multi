# frpc WebUI 管理面板

WebUI 是 frpc 多实例管理面板，用于动态创建、编辑、启动、停止和删除 `frpc` 实例。每个实例对应 `instances/<name>/frpc.toml` 一份配置；单机兼容模式由本机执行层写入 `compose.generated.yaml`，Console / Agent 分离模式由对应 Agent 写入本机 `compose.generated.yaml`，再由 Docker Compose 加载。

## 默认访问

Compose 默认把 WebUI 绑定到宿主机本机地址：

```text
127.0.0.1:8081
```

如果在测试 VPS 上访问，推荐先使用 SSH 隧道：

```bash
ssh -L 8081:127.0.0.1:8081 root@你的VPS_IP
```

浏览器打开：

```text
http://127.0.0.1:8081
```

公网访问、HTTPS 和反向代理由使用者自行配置。

## 启动

单机兼容模式：

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env
docker compose up -d frpc-webui
```

之后通过 WebUI 创建实例。没有配置节点时，创建页默认使用“本机”，继续通过单机兼容 API 管理当前服务器。每次创建/启动实例时，后端会同时刷新 `compose.generated.yaml` 并执行：

```bash
docker compose -f compose.yaml -f compose.generated.yaml up -d <service>
```

如需在命令行直接拉起所有动态实例：

```bash
docker compose -f compose.yaml -f compose.generated.yaml up -d
```

## Console / Agent 模式

多服务器管理时，前端只访问 Console API，Console 再转发到各 Agent。Console 不直接操作 `instances/`、`compose.generated.yaml` 或 Docker socket。

启动 Console：

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env
docker compose -f compose.console.yaml up -d --build
```

启动 Agent：

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env
docker compose -f compose.agent.yaml up -d --build
```

Agent 启动前必须设置高强度 `AGENT_TOKEN`，`compose.agent.yaml` 默认开启 `AGENT_AUTH_ENABLED=true`。Console 页面新增节点时，节点地址填写 Agent 的可访问地址，token 填写该 Agent 的 `AGENT_TOKEN`。一旦存在节点，实例创建和实例操作会使用 `nodeId + instanceName` 路径转发到对应 Agent；没有节点时继续保留本机兼容路径。关键实例变更会写入“审计”页面，单机兼容操作显示为“本机”，远程 Agent 操作显示对应节点。

Console 不挂载 Docker socket。Agent 挂载 Docker socket，只管理本机 `instances/` 和本机 `compose.generated.yaml`。
