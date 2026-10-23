# 服务器分类与大规模数据交互改造 Intent

## TaskIntentDraft

- Goal: 按 `docs/aegis/plans/2026-10-23-server-library-scale.md` 实施服务器分类、百万级资产查询、千万级发现输入和国内测试节点主备接替；先完成可独立验收的切片，逐步推进至计划验收。
- Audience: frpc-multi Console 用户与维护者。
- Scope: 服务端发现调度/持久化、资产与结果数据模型、主备领取、分类查询 API、桌面服务器库 UI、批量操作、兼容迁移、测试与生产验收。
- Non-goals: 手机专项适配；跨多个测试节点同时测同一目标；测试端口可配置；更改 frpc 实例端口；对公网执行千万级压力扫描。
- Stop condition: 计划切片实现并通过规定验证；未达到容量证据的能力保持未验收，阻塞项记录在 checkpoint 并向用户说明。
- Constraints: 一个资产对应规范 IPv4，目标端口固定 7000；本轮发现边界沿用 IPv4-only；一个国内主用测试节点与有序备用节点；统一当前结果，历史记录保留真实执行节点；批量百万目标不传输到浏览器。
- Subagents: 用户明确启用，所有子 Agent 使用 `gpt-6-luna`、`high`；主 Agent 负责 API/数据契约、Git 生命周期、集成和交付。

## TaskStartSnapshot

- Repository: `/Users/zm/Documents/frpc-multi`
- HEAD: `a6d3dc4e9c95dc6b6036e7bab7828b7e9ecb9ea2`
- Branch: `main`, tracking `origin/main`
- Existing worktree: primary worktree only; no other worktrees reported.
- Initial status: modified `docs/aegis/INDEX.md`; untracked `docs/aegis/plans/2026-10-23-server-library-scale.md` (both are the user's requested plan changes from the preceding turn; preserve them).
- Active Git operation: none observed.

## BaselineReadSetHint

- Required: `docs/aegis/plans/2026-10-23-server-library-scale.md`, `docs/aegis/plans/2026-08-30-discovery-performance.md`, `docs/aegis/baseline/2026-08-30-initial-baseline.md`, current probe/backend/frontend owners and tests.
- Acknowledged: revised plan and existing discovery-performance plan read at task start.
- Missing: current production database scale distribution and authoritative domestic primary-node identity must be verified before migration/production rollout.

## BaselineUsageDraft

- Intent authority: revised plan file above.
- Existing compatibility baseline: old discovery-performance plan and current production behavior; do not assume old performance targets establish current capacity evidence.
- Plan constraints consumed: fixed IP:7000 asset identity, stream/bounded discovery, no per-failed-IP rows, domestic primary/backup, no routine source selection, desktop-only, 100k launch acceptance and 1M capacity design.

## ImpactStatementDraft

This changes persistence identity and result selection, task ownership and retry behavior, backend APIs, and the server-library interaction model. Main risks are duplicate or lost scan work, stale execution reports, incorrect IP/port migration, DNS candidate-set changes, and query/write contention. Migrations must be additive or recoverable, preflight conflicts must be explicit, and production rollout requires a database backup and rollback image.
