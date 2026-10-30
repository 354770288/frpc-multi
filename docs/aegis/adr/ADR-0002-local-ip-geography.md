# ADR-0002 - Console 本地归属地事实与自动标签投影

Status: `recorded-from-work`
Date: `2026-10-31`

## Source Evidence

- docs/aegis/work/2026-10-30-ip-geoip/90-evidence.md
## Context

扫描输入可达千万级，资产按十万至百万级设计；自动归属地需要复用测试后留下的有效 IP，且人工标签、业务分组与域名成员分别维护。

## Decision

Console 使用 IPinfo Lite 本地 MMDB；geoip_records 是按规范 IPv4 唯一的识别事实，GeoService 唯一处理持久化队列与整库更新；既有标签表仅承载只读投影，在事实提交事务内同步，手工编辑保留系统关联。

## Alternatives Considered

- 逐 IP 在线 API：存在配额、网络时延及重复消耗；IPinfo Lite 在线版虽不限日月总量，本地整库仍更适合百万级重复处理。
- 为每个 worker 配置数据库并上传自动标签：增加更新副本与来源冲突，故集中于 Console。
## Consequences

- 维护整库下载和版本更新；换取运行时零逐 IP 网络请求、跨节点去重、重启恢复和可追溯来源。
- 系统分类及标签只读；使用 manualLabels/source 保护与自动代码同名的人工标签，原标签筛选继续复用。
## Compatibility Boundary

保留原资产、人工标签、可选业务分组、正式测试及域名候选集合；仅查询当前 IPv4 范围，兼容旧 IPv4:7000 资产；纯未测试导入不主动查询。

## Retirement Impact

不引入在线逐 IP 回退或第二套地区分组；保留旧标签字符串接口作为同一标签事实的兼容投影，不清理用户既有分组。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-10-21-probe-workers.md
- Action: update baseline
- Reason: 新增归属地事实所有者、系统标签来源和鉴权维护接口，需要记录本地实现状态并区别既有生产部署快照。

## Evidence References

- docs/aegis/plans/2026-10-23-server-library-scale.md
- docs/OPERATIONS.md
## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
