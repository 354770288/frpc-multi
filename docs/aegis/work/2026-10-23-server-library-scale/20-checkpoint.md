# 服务器分类与大规模数据交互改造 Checkpoint

## TodoCheckpointDraft

- [x] Baseline and execution contract: inspect discovery, task leasing, result ownership, schema, API, and UI; record current evidence and lock first implementation slice.
- [x] Fixed IP:7000 task semantics and current-result lookup; legacy non-7000 history remains readable.
- [ ] Durable scan recovery, bounded retries, and primary/backup task assignment.
- [ ] Domestic primary/backup scheduler and unified result projection.
- [ ] Classification schema, scalable query APIs, and reversible migration.
- [ ] Desktop server-library UI, saved views, and server-side bulk snapshots.
- [ ] 100k acceptance dataset and isolated 1M capacity tests; regression and release readiness.

## ResumeStateHint

- Current status: first coherent slice is verified; broader plan remains active.
- Active slice: inspect persisted discovery chunk leases/progress and define the smallest durable resume and domestic primary/backup scheduler contract.
- Completed: fixed target port 7000 across task creation paths; server result projection matches fixed port regardless of frps_port setting; HTTP validation maps to 400 including compatibility and route-start paths; historical alternate-port record remains retrievable.
- Next: capture evidence and review outcomes, commit only task-owned paths, then start the scan recovery/failover slice.

## Execution Readiness View

- Intent lock: fixed port 7000 and one asset per normalized IPv4; discovery remains IPv4-only; domestic main/standby failover, one accepted current result; 10万 launch acceptance, 100万 capacity target; no mobile scope.
- Scope fence: implement only plan surfaces; do not mix unrelated front-end redesign work.
- Baseline lock: existing SQLite canonical history and job/task store are the facts to preserve; no unverified claims about existing production scale.
- Compatibility: old APIs remain through adapters during transition; existing histories retain node identity; domain selection policy stays the same apart from its result input becoming unified.
- Retirement: remove multi-node fan-out/source-selector paths only after compatibility callers are migrated; do not keep two writable result owners.
- Verification: per-slice tests, full relevant regressions, migration preflight, bounded-memory scan evidence, failover/stale-report evidence, 100k/1M query/load evidence.
- Review gates: spec compliance then code quality review for each delegated implementation slice; coordinator integrates and owns Git mutations.
- Rollback: preserve data backup and matching prior image before production rollout; restore database snapshot when rolling back schema/data conversion.

## DriftCheckDraft

- Decision: continue after source-of-truth audit.
- Scope/compatibility: aligned with revised plan; old plan remains a historical baseline pending comparison with current code.
- Open unknowns: current production domestic primary; result consumers that assume multi-node results; feasibility of 1M target data under existing SQLite deployment.
- Slice result: 10万/100万 capacity and performance remain unverified; no production writes or deployment occurred.
