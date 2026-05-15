# frpc WebUI 管理面板

WebUI 是二期管理面板，用于动态创建、编辑、启动、停止和删除 `frpc` 实例。

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

如果要使用动态实例：

```bash
docker compose -f compose.yaml -f compose.generated.yaml up -d
```

## 迁移旧配置

从一期 `configs/client-*/frpc.toml` 迁移到二期 `instances/`：

```bash
cd /opt/frpc-multi
bash scripts/migrate-configs-to-instances.sh
```

脚本会保留旧 `configs/`，不会删除原文件。

