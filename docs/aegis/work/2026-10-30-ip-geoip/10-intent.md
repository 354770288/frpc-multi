# 本地 IP 归属地任务边界

用户批准：IPinfo Lite 本地 MMDB、发现命中及已正式测试资产自动识别国家/地区与 ASN；人工标签、可选业务分组、测量状态及域名候选分别维护。

## 交付与停止条件

- Console 事实、持久化处理及更新服务；鉴权 API、自动标签来源保护、前端展示与系统维护入口。
- 同步现有服务器分类计划与运维说明；保留用户资产和历史，不替换生产部署。
- 针对性故障和兼容回归通过；十万及百万隔离容量报告明确数据密度、硬件、实际后台节奏和极限饱和结果；通过后归档并本地提交。
- 不接入逐 IP 在线 API、不扩展 IPv6 查询、不清理原业务分组、不更改 DNS 或执行线上发布。

## 基线与已读证据

- 服务器分类与容量计划：docs/aegis/plans/2026-10-23-server-library-scale.md。
- 独立域名候选：docs/aegis/plans/2026-10-30-domain-candidates.md 及当前 lb_domain_servers 实现。
- 当前正式结果接受、标签关联/兼容投影、SQLite 生命周期和既有源码测试。
- 遗留部署历史：docs/aegis/baseline/2026-10-21-probe-workers.md。新实现仅追加本地增量，不据此宣称部署状态改变。

## 所有权与兼容

- GeoService/GeoStore 唯一维护归属地事实和后台生命周期，原标签存储继续拥有字典、关联和人工编辑接口。
- 系统标签从事实生成，使用 source/readOnly；manualLabels 保留同名人工属性。原标签字符串接口仍映射同一事实。
- 查询容量修复在现有 ProbeStore/SQLite 连接配置层完成，不新增平行缓存、分组事实或逐 IP 回退。
- TDD off/skipped：实现后回归；不以绿灯测试替代整个批准计划的验收。

执行快照与恢复状态见 20-checkpoint.md，独立检查和容量证据见 90-evidence.md。
