# 全功能测试节点 - Checkpoint

- Task ID: 2026-10-20-probe-workers
- Current todo: 已完成部署与验收，交接记录同步
- Active slice: closeout
- Blocked on: none
- Next step: 常规使用；新增测试通过页面手动发起

## 最终状态（2026-10-21）

主控 23.19.228.204:8081 与深圳电信-ubuntu-work（SSH 10.144.1.5:22）均运行代码版本 da8603c，两个测试节点在线并具备 discover / route / connectivity / speed 四项能力。后续收尾仅由主 Agent 执行；不启动或续接子 Agent。

- 后端 247 项测试、前端构建、异步竞态与端点边界检查通过；GitHub Actions 39600936597 成功。
- 双节点扫描后自动完整测试共 8 阶段全部 done；路由跳点、穿透三项状态和真实上下行字节均已核对。
- 排队任务跨主控重启保持相同 ID，节点上线后完成；运行中取消后 frpc 子进程及本地端口已释放。
- 全局 LB 观测来源为国内节点 UUID，24h；主控健康检查保持独立。临时域名完成国内观测选优、节点离线保留健康 IP、目标故障切备用、恢复后保守保留健康当前 IP、仅调整临时池后同步恢复目标。
- 原有 4 个业务域名指向不变；3 个管理 Agent 在线、3 个实例运行；服务器资产恢复为 2319。真实测试任务及结果作为验收历史保留。
- 临时 Cloudflare 记录回读为 0；临时域名、分组、2 项资产、frps 服务与单元、隔离查询容器已清理。国内 frpc-probe enabled/running，原 frpc-route 停用保留回滚。
- 主控镜像 revision da8603c46f7438a6cd4245f16f2ca3d519b1a5b3；最终备份 console-before-probe-workers-da8603c.db，旧镜像 rollback-probe-workers-20261021 保留。

## 重要修订

首次 bf38e29 部署暴露真实规模下的来源查询性能回归，已先回滚；345eb37 改为每资产索引 seek 与只读临时投影，真实备份及最终镜像验证后重新上线。da8603c 另提供固定版本官方 frp 本地缓存安装输入，国内节点已使用并核对 SHA256。

## 验收边界

自定义端口 17000 已用于真实测试与 DNS 端点分离验收；发现导入仍沿用既有手动语义，未宣称自定义端口导入能力。Console 测速属于同机回环样本。arm64 镜像经 CI 构建，本次真实节点为 amd64。工作区 helper 仅有任务开始前已存在的治理文档格式检查失败，见证据记录。

证据：90-evidence.md；架构：../../adr/ADR-0001-durable-probe-workers.md；基线：../../baseline/2026-10-21-probe-workers.md。
