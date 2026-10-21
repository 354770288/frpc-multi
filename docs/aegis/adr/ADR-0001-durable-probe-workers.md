# ADR-0001 - 统一持久化测试任务与独立观测来源

Status: `recorded-from-work`
Date: `2026-10-21`

## Source Evidence

- docs/aegis/work/2026-10-20-probe-workers/90-evidence.md
## Context

旧路由节点仅有内存队列，测试引擎和历史缺少完整执行来源；继续增加独立队列会产生重启丢失和跨节点结果混用。

## Decision

由ProbeJobStore唯一拥有SQLite任务、租约、attempt和规范化结果；Console与出站HTTP worker使用同一协议。按稳定节点ID及主机端口隔离观测，国内节点只参与LB排序，健康检查继续由主控负责。

## Alternatives Considered

- 保留旧路由内存队列并为穿透和测速分别扩展队列：身份与恢复语义重复，难以保持阶段依赖和取消清理一致。
- 将实例管理Agent直接扩为测量执行器：耦合管理权限与测试生命周期，扩大升级影响。
## Consequences

- 需要持久化迁移、租约隔离、幂等回报和端点锁；换取重启续跑、多节点全目标执行及来源一致的查询和DNS选优。
## Compatibility Boundary

保留资产、标签、手动导入、旧历史、原管理Agent和主控健康检查；旧路由节点保留身份，升级前只提供路由能力。

## Retirement Impact

旧HTTP入口作为统一队列适配层，历史表仅兼容读取；原frpc-route服务停用并保留回滚配置，确认全部旧节点升级及回滚窗口结束后再评估移除。

## Baseline Sync

- Needed: needed
- Target: docs/aegis/baseline/2026-10-21-probe-workers.md
- Action: update baseline
- Reason: 任务与结果所有者、API协议及安装兼容边界已改变，基线需要记录最终版本和真实部署证据。

## Evidence References

- docs/aegis/plans/2026-10-20-probe-workers.md
- docs/aegis/work/2026-10-20-probe-workers/90-evidence.md
## Boundary

This ADR is an advisory Aegis Method Pack record. It does not grant completion authority or replace project-authoritative architecture sources.
