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

The UI does not yet consume this endpoint and task creation does not yet assign by this policy. Capacity, lease failover, unified results, and production node selection remain unverified.
