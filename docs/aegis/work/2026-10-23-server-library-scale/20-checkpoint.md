# 服务器分类与大规模数据交互改造 Checkpoint

## TodoCheckpointDraft

- [x] Baseline and execution contract: inspect discovery, task leasing, result ownership, schema, API, and UI; record current evidence and lock first implementation slice.
- [x] Fixed IP:7000 task semantics and current-result lookup; legacy non-7000 history remains readable.
- [x] Persisted primary/backup policy API with validation and deletion guard.
- [x] Desktop test-node management for explicit primary/backup ordering.
- [x] New task creation automatically assigns only to configured primary.
- [x] Remove execution-node and port selectors from task creation UI; summarize saved primary/backup policy.
- [x] Lease-based backup transfer, generation fencing, bounded failover work, transfer history, and waiting-state UI.
- [x] Domestic primary/backup scheduler and backend unified current-result projection with LB reader.
- [x] Switch server-library current-result queries and daily UI to the unified projection; remove source switching/comparison.
- [x] Stable group IDs across assets, discovery candidates, and LB domains; block deletion while referenced.
- [ ] Categorized tag dictionary/relations and separation of measurement facts from manual labels.
- [ ] Classification schema, scalable query APIs, and reversible migration.
- [ ] Desktop server-library UI, saved views, and server-side bulk snapshots.
- [ ] 100k acceptance dataset and isolated 1M capacity tests; regression and release readiness.

## ResumeStateHint

- Current status: fixed-port, node-policy API/UI, atomic primary assignment, durable lease failover, unified current-result projection/LB, and source-free server-library current views are verified; broader plan remains active.
- Active slice: normalize categorized tags and separate measurement facts, then implement scalable queries and large-library UI work.
- Completed: fixed target port 7000 across task creation paths; server result projection matches fixed port regardless of frps_port setting; HTTP validation maps to 400 including compatibility and route-start paths; historical alternate-port record remains retrievable; persisted policy validates stable worker IDs, preserves backup order, permits offline nodes, fails closed on corrupt state, protects referenced-node deletion; desktop test-node page explicitly saves primary and ordered backups; public task creation resolves the saved primary and checks policy plus inserts tasks atomically; task creation/discovery UI shows the saved role policy, distinguishes policy/node-list errors, submits no nodeIds and fixes port 7000.
- Completed failover: jobs snapshot the ordered node chain; expired/unclaimed tasks transfer only to the next online generation-capable backup; pipeline child tasks preserve generation; old attempts are fenced; no-backup tasks remain pending and recover on owner heartbeat; transfer history is paged; batch waiting count is independent of task filters/pages.
- Current-result foundation: canonical history stays immutable; a durable route/connectivity/speed projection seeds only from the first valid configured primary, updates only on accepted primary-managed results (including failover owners), stores provenance, clears with its source history, and is read by LB through candidate-group-scoped queries at fixed port 7000. Legacy history/source APIs remain during consumer migration.
- Server-library consumers now use unified route/connectivity/speed views regardless of legacy `nodeId` parameters; daily source selectors and cross-node comparison controls are removed while history retains actual-node filters/provenance. Non-7000 endpoint rows do not inherit the fixed-7000 current result.
- Stable group IDs now back asset, discovery, and LB references; migration is one-time and retryable, rename preserves identity, name/ID compatibility remains, and deleting a referenced group returns 409.
- Next: normalize categorized tags without converting route-result labels into manual tags, then implement classification/filter/query APIs and UI, followed by batch snapshots and capacity acceptance.

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
- Open unknowns: current production domestic primary must be explicitly selected; result consumers that assume multi-node results; feasibility of 1M target data under existing SQLite deployment.
- Slice result: backup lease transfer, unified current-result backend/LB/server views, and stable group identity are implemented and regression-tested; categorized tags, scalable server queries, 10万/100万 capacity, scan throughput/memory, and full rollout migration remain unverified; no production writes or deployment occurred.
