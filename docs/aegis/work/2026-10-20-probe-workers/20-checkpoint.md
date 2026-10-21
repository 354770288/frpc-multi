# 全功能测试节点 - Checkpoint

- Task ID: 2026-10-20-probe-workers
- Current todo: 后端与协议实现
- Active slice: backend
- Blocked on: none
- Next step: 子agent实施后端、独立审查、前端与部署集成

## Checkpoint Update

- Current todo: 后端worker实现、LB审查、前端待接入
- Active slice: backend-and-lb
- Completed todos:
- 基线204后端测试通过；LB全局来源选优实现与34项测试通过
- Evidence refs:
- none
- Blocked on: none
- Next step: 完成后端协议并审查，随后前端实施和真实部署

## Checkpoint Update

- Current todo: 前端实施与实际部署验收
- Active slice: frontend
- Completed todos:
- 后端与worker实现；独立spec与quality审查通过；父fresh242tests通过；LB37tests与独立审查通过；真实数据库迁移6表逐行保留及历史可见性验证
- Evidence refs:
- webui/backend/tests/test_probe_jobs.py
- webui/backend/tests/test_lb_selection.py
- Blocked on: none
- Next step: frontend_sol实施全部frontend后独立审查/构建/浏览器验证；提交推送构建；主控和国内节点部署与真实fixture验收

## Checkpoint Update

- Current todo: 前端quality两项修复和复审、提交推送构建、真实部署验收
- Active slice: frontend-review
- Completed todos:
- 后端ec30a27已本地提交；最新243项后端tests通过；前端specPASS/buildPASS；browser来源隔离/0值/hops/跨页保留/quick目标锁/2节点2目标4任务/skip-stop-retry-刷新恢复通过；LB配置本地保存通过
- Evidence refs:
- webui/backend/tests/test_probe_jobs.py
- Blocked on: none
- Next step: frontend_sol修IPv6对比与旧job action回写竞态；lb_quality_review复跑其harness；父build/审diff后提交推送、等待CI、备份再部署主控+国内节点、frps17000全链路和测试DNS
