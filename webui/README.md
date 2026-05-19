# frpc WebUI 管理面板

WebUI 是 frpc 多实例管理面板，用于动态创建、编辑、启动、停止和删除 `frpc` 实例。每个实例对应 `instances/<name>/frpc.toml` 一份配置，由 WebUI 写入 `compose.generated.yaml`，与 `compose.yaml` 一起被 `docker compose` 加载。

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

```bash
cd /opt/frpc-multi
cp .env.example .env
nano .env
docker compose up -d frpc-webui
```

之后通过 WebUI 创建实例。每次创建/启动实例时，后端会同时刷新 `compose.generated.yaml` 并执行：

```bash
docker compose -f compose.yaml -f compose.generated.yaml up -d <service>
```

如需在命令行直接拉起所有动态实例：

```bash
docker compose -f compose.yaml -f compose.generated.yaml up -d
```
