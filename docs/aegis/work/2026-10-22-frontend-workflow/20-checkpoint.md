# 前端流程重组 - Checkpoint

- Task ID: 2026-10-22-frontend-workflow
- Current todo: 前端与兼容API实现
- Active slice: implementation
- Blocked on: none
- Next step: 完成剩余深链接和端到端验收

## Checkpoint Update

- Current todo: 完成端到端验证和生产部署
- Active slice: verification
- Completed todos:
- 导航与资源测试页面已拆分；兼容API分页和显式目标已实现；域名状态和配置草稿保护已实现；247项后端测试通过；8条隔离浏览器流程通过
- Evidence refs:
- webui/backend/tests/test_probe_jobs.py
- webui/frontend/e2e/test-creation.spec.ts
- Blocked on: none
- Next step: 复跑全测试与真实数据性能；检查线上可达性和备份后部署

## DriftCheckDraft

- Scope status: 按已批准前端计划实现导航和兼容API
- Compatibility status: 旧probe和create路由跳转已验证；worker协议与DNS算法未动
- Retirement status: 旧路由适配暂留；手写弹窗封装已迁至shadcn原语
- New risk signals:
- 尚未完成生产镜像与线上验收
- Advisory decision: continue

## Checkpoint Update

- Current todo: CI镜像构建、备份与生产验收
- Active slice: rollout
- Completed todos:
- 兼容分页和显式目标、导航重组、三步新建、草稿保护、域名状态、历史与审计服务端分页已实现
- 后端250项、Vitest3项、Playwright11项与前端构建全部通过；真实备份索引迁移和分页性能通过
- Evidence refs:
- docs/aegis/work/2026-10-22-frontend-workflow/evidence-bundle-draft-local-verification.json
- Blocked on: none
- Next step: 提交推送后等待CI成功，生产备份与镜像回滚准备，然后更新主控并只读验收

## Checkpoint Update

- Current todo: 已完成，交接记录待提交
- Active slice: closeout
- Completed todos:
- 代码88663b4已推送，CI39895272783成功，主控已部署验收
- 保留生产DB备份0600与可用da8603c回滚镜像；未触碰测试节点和业务DNS
- Evidence refs:
- docs/aegis/work/2026-10-22-frontend-workflow/90-evidence.md
- Blocked on: none
- Next step: 更新反思与校验工作区，提交并推送部署证据文档

## Checkpoint Update

- Current todo: 前端改造与线上验收完成
- Active slice: complete
- Completed todos:
- 主控已部署88663b4；GHCR多架构CI 39895272783成功
- 250项后端回归、3项Vitest、11项Playwright、前端构建通过
- 真实备份隔离迁移与查询通过；主控API、导航、任务详情、双节点对比、域名、3个Agent/实例验收通过
- Evidence refs:
- docs/aegis/work/2026-10-22-frontend-workflow/90-evidence.md
- docs/aegis/work/2026-10-22-frontend-workflow/evidence-bundle-draft-production-rollout.json
- Blocked on: none
- Next step: 日常使用；worker保持兼容版本da8603c，测试节点协议未改
