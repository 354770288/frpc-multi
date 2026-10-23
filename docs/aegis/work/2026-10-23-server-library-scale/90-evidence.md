# 服务器分类与大规模数据交互 Evidence

## Slice: fixed target port

- `./.venv/bin/python -m unittest tests.test_probe_jobs` — exit 0; 35 tests passed.
- `./.venv/bin/python -m unittest tests.test_probe.ProbeApiTests.test_remote_full_history_without_imported_asset tests.test_probe.DiscoverApiTests.test_discover_lifecycle_and_import tests.test_probe.RouteApiTests.test_scan_auto_route_enqueues` — exit 0; 3 tests passed.
- `./.venv/bin/python -m unittest tests.test_probe` — exit 0; 77 tests passed in 31.588s.
- `git diff --check` — exit 0.
- Spec compliance review: fixed-port slice approved after fixes to stale history fixture and route-start error mapping.
- Code quality review: no Critical or Important findings. Minor note: `/api/probe/compare` and `ProbeOptions` retain existing defaults for historical/engine roles; they do not create persisted jobs. Revisit comparison endpoint during planned removal of routine multi-node comparison.

## What this proves

- New task creation rejects non-integer, boolean, alternate, and explicit non-7000 endpoint ports.
- Public and legacy APIs use 7000 or return HTTP 400. Discovery tests retain the coordinator, persistence, and API lifecycle while mocking only TCP.
- A 7000 result remains visible in the asset current-result projection when configured `frps_port=7001`.
- A directly seeded historical 7001 result remains visible through history with its original port.

## Uncovered scope and residual risk

- No full backend suite was run; the complete `test_probe` module and all directly affected probe-job tests passed.
- No 100k/1M capacity test, 10M scan throughput/memory run, persistent recovery/failover test, production-data migration preflight, or production deployment was performed.
- The historical `/api/probe/compare` compatibility endpoint remains and is scheduled for review when its UI/API retirement slice is implemented.

Confidence for this slice: A for fixed-port behavior and directly affected probe regressions; C for the overall plan and scale capacity.

## Slice: persisted primary/backup policy API

- `./.venv/bin/python -m unittest tests.test_probe_jobs` — exit 0; 40 tests passed.
- `git diff --check` — exit 0.
- Spec review: no remaining findings after fail-closed corruption handling.
- Code-quality review: one concurrent-delete status inconsistency was fixed and independently rechecked; no remaining findings.
- Regression coverage: eligible/ineligible and offline nodes, order and uniqueness, non-persisted suggestion, corrupt policy repair, fail-closed deletion, unchanged in-flight jobs, and concurrent legacy deletion mapping.

At the policy-backend/UI slice boundary, task creation had not yet been connected to the saved policy; the following assignment slice records that integration. Capacity, lease failover, unified results, and production node selection remain unverified.

## Slice: desktop test-node policy UI

- `npm run build` — exit 0; TypeScript and Vite production bundle passed.
- `npm test` — exit 0; 2 files and 3 Vitest tests passed.
- `git diff --check` — exit 0.
- Spec review: no remaining findings after unsaved-suggestion and in-flight-save handling fixes.
- Code-quality review: no actionable findings.

The UI policy editor itself did not assign tasks; assignment was implemented and verified in the next slice. Lease failover and unified current results remain subsequent slices.

## Slice: primary-only task creation UI

- `npm run build` — exit 0; TypeScript and Vite production bundle passed.
- `npm test` — exit 0; 2 files and 3 Vitest tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — exit 0; 15 Playwright tests passed.
- `git diff --check` — exit 0.
- Spec review: no remaining findings after E2E fixtures were aligned to external primary/backup workers.
- Code-quality review: stale refresh, API error distinction, source guidance, and unmount request lifecycle findings fixed and rechecked.

Evidence covers primary/backup summary display, omitted nodeIds, fixed scan port, rejection of explicit alternate target ports, policy and node-list failures/retries, and unchanged instance-port handoff. Lease failover and result-source unification remain unimplemented.

## Slice: atomic primary-only task assignment

- `./.venv/bin/python -m unittest tests.test_probe` — exit 0; 74 tests passed.
- `./.venv/bin/python -m unittest tests.test_probe_jobs` — exit 0; 45 tests passed.
- `git diff --check` — exit 0.
- Spec review: no remaining findings after adding compatibility selection regressions.
- Code-quality review: no blocking or correctness findings; optional future HTTP claim/report coverage noted.

Policy validation, node eligibility, job creation, and task insertion run in one immediate write transaction. Compatibility entry points reject multiple, duplicate, or non-primary node IDs before busy-state responses and revalidate in the creation transaction. Backup failover and unified result projection remain unimplemented.

## Slice: lease failover and transfer history

- `./.venv/bin/python -m unittest tests.test_probe_jobs tests.test_probe` — exit 0; 135 tests passed after the final unfiltered batch waiting count addition.
- `npm run build` — exit 0.
- `npm test` — 2 files, 3 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — 17 Playwright tests passed, including protocol-gated backup status, paginated transfer history, and batch waiting state independent of task filters/pages.
- `git diff --check` — exit 0 before the final documentation update.
- Spec and quality reviews found generation loss on pipeline child tasks, stale wait marking, unbounded policy scans, missing protocol status, and batch waiting UI inaccuracies; each finding was fixed and covered by regression tests before final re-review.

Failover now snapshots the ordered policy into each job, transfers unfinished tasks only after lease/owner failure, increments and validates execution generation, preserves generation across pipeline stages, and requires the protocol feature on backup claim. Sweep work is bounded to at most 500 job/owner pairs and 500 task IDs per poll, with persistent cursor progress. Task transfer audit rows are available through a paginated endpoint. Legacy workers remain compatible for generation-zero primary tasks; backups without the new feature remain on standby.

The full scale target, unified current-result projection and source migration, classification/filter/query redesign, 100k acceptance data, 1M stress, 10M scan throughput/memory, and production deployment remain unverified.
