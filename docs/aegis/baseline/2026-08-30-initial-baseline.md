# frpc-multi Initial Dual Baseline

Date: 2026-08-30
Status: initial dual-baseline snapshot

## Purpose

Support alignment checks for the approved discovery-performance work.

## Authority surfaces

- `chat/PERF_OPT_HANDOFF_2026-08-29.md`: performance investigation and implementation handoff.
- `chat/PROJECT_MEMO_2026-08-22.md`: project architecture and production-data cautions.
- Current backend/frontend source and tests: runtime truth.
- User-approved design in the 2026-08-30 session: target behavior for this work.

## Product / Requirement Baseline

- Centralized frpc management includes authorized-network server discovery.
- Discovery must accept at most 10,000,000 unique effective IPv4 targets after exclusions without eager expansion.
- Results use server-side filtering, stable sorting, and offset pagination; page selection is explicit-ID and current-page select-all only.
- IPv6 discovery, distributed scanning, resume, FTS, select-all-matching, and completion-time SLA are non-goals.
- Acceptance requires backend regression, frontend build, bounded-memory/scheduling evidence, review, and handoff update.

## Architecture / Runtime Boundary Baseline

- `probe/discover.py` owns target normalization and bounded scan execution.
- `probe/store.py` owns probe persistence/query behavior.
- `control/database.py` owns schema, migration, and connection setup.
- `probe/router.py` owns HTTP contracts and orchestration.
- Probe frontend/API/types own pagination consumption and UI behavior.
- SQLite connections remain owner-local; no global cross-thread connection.
- Persisted discovery rows are authoritative; scan status carries bounded summary only.

## Compatibility boundary

Preserve existing server records and migrations, authorized-network safety language, concurrency/timeout bounds, import semantics for valid IDs, and all unrelated route/LB/control behavior. Never run load fixtures against configured production data.
