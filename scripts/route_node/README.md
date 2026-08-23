# 路由测试节点部署（Debian / Ubuntu）

国内服务器上运行，对「网段发现」里的 frps 设备做去程路由追踪（mtr），
判定是否 CN2 线路（任一跳 `59.43.*`）。**节点无需公网 IP**——它主动轮询
主控领任务，只需能出站访问主控面板地址。

## 一、安装依赖

```bash
apt update && apt install -y mtr python3
```

## 二、放置脚本

```bash
mkdir -p /opt/frpc-route
# 把本目录的 route_node.py 上传到 /opt/frpc-route/route_node.py
```

## 三、在面板创建节点并拿 Token

面板 → 服务器库 → 网段发现 → **路由节点** → 新增节点（如「杭州节点」），
复制生成的 Token（只显示一次）。

## 四、配置 systemd 常驻 + 开机自启

```bash
cat > /etc/systemd/system/frpc-route.service <<'EOF'
[Unit]
Description=frpc-multi route test node (CN2 mtr)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CONSOLE_URL=http://你的主控地址:8081
Environment=ROUTE_TOKEN=粘贴面板生成的Token
ExecStart=/usr/bin/python3 /opt/frpc-route/route_node.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now frpc-route
systemctl status frpc-route        # 看运行状态
journalctl -u frpc-route -f        # 跟踪日志（领取任务/CN2 判定结果）
```

## 五、自测

```bash
# 1) Token 是否有效（应返回 {"task": null} 或任务，而不是 401）
curl -s -X POST http://你的主控地址:8081/api/probe/route/claim \
  -H "X-Route-Token: 你的Token"

# 2) 手动跑一次 mtr 确认工具正常（应输出 JSON，hops 里含路由）
mtr --json --no-dns -c 5 223.5.5.5 | head -c 300
```

## 多节点部署

面板「路由节点」再新增一个节点 → 新 Token → 新机器重复上面四步即可。
多个节点同时轮询，任务先到先得（自动负载均衡）；某节点掉线后，其领取
超过 120 秒未回报的任务会被主控自动回收并派给其他节点，无需人工干预。

## 说明

- 结论标签写回网段发现列表：`CN2`（绿）/ `非CN2`（红）/ `未路由测试`（灰），
  导入服务器库时标签随行带入。
- 路由结论取决于该节点所在地的运营商出口；建议在关心的每个地域各部署一个节点。
- 安全：节点仅出站连接；主控侧 claim/report 仅凭 Token（可在面板删除节点即时吊销）。
