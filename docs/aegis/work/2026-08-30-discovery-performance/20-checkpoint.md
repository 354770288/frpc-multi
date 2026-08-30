# Todo Checkpoint

- Completed: baseline/handoff audit; approved design/plan; Task 1 SQLite lifecycle; Task 2 bounded lazy scanner; Task 3 discovery migration, paging/facets, ID chunking, selected import, and transactional batch UPSERT; Task 3 specification and quality review loops.
- Active slice: Task 3 closeout and scoped commit, then Task 4 router contracts and bounded persistence-writer orchestration.
- Pending: router orchestration; frontend paged workflow; integrated verification/review/docs.
- Evidence: Task 1 commit `e2b1f6a`; Task 2 commit `78cc4e4`; Task 3 focused database/probe suite 69 passing; full backend suite 170 passing; production-shaped query-plan probe passed for group, label, and combined filters in ASC/DESC without `TEMP B-TREE`; `git diff --check` clean; specification and quality reviews approved with confidence A.
- Blocked on: nothing.
- Next: commit only Task 3-owned implementation/tests plus durable Aegis records, read back Git state, then open the Task 4 implementation gate.

## ResumeStateHint

Read the plan, this checkpoint, `chat/PERF_OPT_HANDOFF_2026-08-29.md`, and `git status`; do not touch production DB, deploy, or let subagents mutate Git lifecycle state.

## Slice Card

- Goal: provide data-preserving numeric IPv4 ordering, globally correct paged queries/facets, bounded atomic ID operations, selected-row import, and transactional scanner batch UPSERT.
- Parent plan/spec: Task 3 in `docs/aegis/plans/2026-08-30-discovery-performance.md`.
- Files: `webui/backend/app/control/database.py`, `webui/backend/app/probe/store.py`, `webui/backend/tests/test_database.py`, and `webui/backend/tests/test_probe.py`.
- Boundary: no router/API/frontend changes; persisted rows remain canonical truth; `list_discover_results()` survives only as the explicit Task 4 migration carrier.
- Verification: focused database/probe tests, full backend regression, query-plan probes, diff/scope checks, then specification and quality reviews.
- Stop: do not enter Task 4 until Task 3 reviews, fresh coordinator verification, durable records, and scoped commit pass.

## DriftCheckDraft

Tasks 1–3 match the intent lock, scope fence, baseline lock, canonical-owner rules, compatibility and retirement boundaries, test obligations, and review gates. Task 3 stayed inside the database/store owners: one atomic bounded backfill preserves invalid legacy rows with `ip_sort=NULL`; stable null-last numeric IP order and measured indexes support pages; facets remain global; normalized/chunked ID mutations are atomic; selected imports avoid full-table materialization; batch UPSERT preserves metadata and does not own route enqueueing. No router/API/frontend work, destructive live-state operation, fallback, adapter, or duplicate persistence owner appeared. The sole old full-result reader remains only as the explicit Task 4 migration carrier with a retirement trigger. Residual risks are migration write-lock duration, accepted offset-page movement during active scans, and SQLite single-writer serialization. Decision: continue.
