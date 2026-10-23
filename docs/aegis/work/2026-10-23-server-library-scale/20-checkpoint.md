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
- [x] Categorized tag dictionary/relations, CRUD/merge/assignment API, and tag-ID filtering/facets.
- [x] Desktop categorized-tag management, tag-ID filtering/assignment, and legacy label compatibility.
- [x] Signed IP-sort cursor API, independent count endpoint, multi-ID backend filters, and no-full-TEMP server result views.
- [x] Backend contextual group/tag facet counts using the shared list filter interpreter and current-result projection.
- [x] Desktop multi-group and include-all/any/exclude tag controls with contextual counts and URL state.
- [x] Backend server-side selection snapshots and asynchronous update/delete batch progress APIs, with durable recovery, failure paging/retry, and bounded cleanup.
- [x] Desktop server-library integration for fixed all-match snapshots, async group/tag/delete updates, progress, failure paging, and retry; explicit test selection remains separate.
- [x] Backend selection-backed probe-job creation with bounded producer, backlog cap, saved-policy failover, idempotency, and stop/retry retention.
- [x] Desktop selection-backed test creation/progress; group/all targets use server snapshots; explicit/manual targets capped at 5,000.
- [x] Desktop multi-group union and include-any/include-all/exclude tag controls with URL state and contextual counts.
- [x] Backend opt-in tag candidate search/pagination with full legacy no-argument facet compatibility.
- [x] Desktop searchable/server-paged tag candidates for advanced filters and quick-tag shortcuts.
- [x] Console-shared saved views with filters/sort/visible columns, and indexed speed/time sorting.
- [x] Isolated 1M storage capacity acceptance for migration, listing, counts, facets, selection snapshots, and bounded task production.
- [x] 10M target-range planning and initial discovery task creation smoke test without per-IP expansion.
- [ ] 100k end-to-end mutation/import acceptance; remaining regression and release readiness.

## ResumeStateHint

- Current status: fixed-port semantics, node policy, atomic primary assignment, durable lease failover, unified results/LB/server views, stable groups, categorized-tag backend/UI, IP keyset browsing, desktop fixed-selection/update/delete workflows, desktop selection-backed test creation, multi-group/contextual filters, paged tag candidates, Console-shared saved views, indexed speed/time sorting, isolated 100万 storage paths, and 10M range planning/task creation smoke validation are verified; end-to-end mutation/import acceptance remains active.
- Active slice: complete 10万 end-to-end mutation/import acceptance and assess actual scan worker throughput/memory under a synthetic/local fixture, then finalize regression and migration review.
- Completed: fixed target port 7000 across task creation paths; server result projection matches fixed port regardless of frps_port setting; HTTP validation maps to 400 including compatibility and route-start paths; historical alternate-port record remains retrievable; persisted policy validates stable worker IDs, preserves backup order, permits offline nodes, fails closed on corrupt state, protects referenced-node deletion; desktop test-node page explicitly saves primary and ordered backups; public task creation resolves the saved primary and checks policy plus inserts tasks atomically; task creation/discovery UI shows the saved role policy, distinguishes policy/node-list errors, submits no nodeIds and fixes port 7000.
- Completed failover: jobs snapshot the ordered node chain; expired/unclaimed tasks transfer only to the next online generation-capable backup; pipeline child tasks preserve generation; old attempts are fenced; no-backup tasks remain pending and recover on owner heartbeat; transfer history is paged; batch waiting count is independent of task filters/pages.
- Current-result foundation: canonical history stays immutable; a durable route/connectivity/speed projection seeds only from the first valid configured primary, updates only on accepted primary-managed results (including failover owners), stores provenance, clears with its source history, and is read by LB through candidate-group-scoped queries at fixed port 7000. Legacy history/source APIs remain during consumer migration.
- Server-library consumers now use unified route/connectivity/speed views regardless of legacy `nodeId` parameters; daily source selectors and cross-node comparison controls are removed while history retains actual-node filters/provenance. Non-7000 endpoint rows do not inherit the fixed-7000 current result.
- Stable group IDs now back asset, discovery, and LB references; migration is one-time and retryable, rename preserves identity, name/ID compatibility remains, and deleting a referenced group returns 409.
- Tag backend now has stable category/tag IDs, many-to-many asset assignments, name/category CRUD, tag rename/move/merge/delete, legacy-label compatibility projection, tag-ID assignment/filtering, and category-aware facets. Legacy route-like names are preserved as manual labels where provenance is absent; current route measurements remain in the separate result projection.
- Synchronous text import is capped at 5,000 endpoints / 1 MiB; larger imports still need the planned async job/progress flow. The server library uses a signed cursor for IP sort and a separate exact-count endpoint; non-IP sorts retain the offset compatibility route. Backend all-match snapshots bind owner, filters (including legacy labels), a high-water server ID, and catalog revision; a revision change during bounded construction fails the snapshot explicitly. Update/delete operations materialize targets in bounded ranges, process 250-item transactions, expose progress and paged failures, retry only terminal failed rows, fence stale workers with lease tokens, and retain expired/terminal rows through bounded cleanup. The desktop now offers frozen all-match selection and asynchronous group, tag, and delete actions while preserving explicit selection for test launch. Selection-backed test-job creation remains a separate task-production slice.
- Selection-backed test-job API now validates the owner-bound ready selection and saved primary policy atomically, fingerprints owner-scoped idempotency requests before expiry/policy checks, and creates regular probe jobs with a durable target producer. Claims materialize at most 250 targets per transaction, stop at 500 active tasks, and use a monotone cursor. The bounded failover sweep transfers zero-task or partially materialized producers along the job's saved primary/backup chain, carrying generation and recording producer transfer history. Whole-job stop preserves resumable membership for seven days; whole-job retry resumes from the cursor, while task-only retry does not resume production. Node deletion is blocked while snapshot-backed jobs are active or resumable. The desktop has not yet submitted selection-backed test jobs.
- TestCreatePage now loads deep-linked server snapshots by ID; group and all-server scopes create/poll server-side snapshots instead of paging IPs into React. Submission sends only selection ID, mode, and an idempotency key. Scope, group, and mode remain synchronized with URL history; generated IDs replace the current entry, reload resumes polling/submission, and Back/Forward does not create duplicate snapshots. Manual and selected explicit targets are limited to 5,000. The job list/detail shows target materialization and failover-waiting progress.
- Server facet API now accepts the list/count filter contract. Group counts remove group/group-ID filters while retaining other dimensions; tag/category and legacy-label counts remove label/tag filters while retaining query, group, and measurement filters. Counts use SQL aggregates over assets, tag relations, and the unified current-result projection.
- Tag facet candidates now support opt-in case-insensitive category/name search and stable SQL pagination. Search/page filters candidates only; contextual counts remain based on all matching servers. Legacy no-argument calls continue returning the full historical tag candidate set and original response keys. Page size is limited to 100, page number to 1,000,000, and empty pages retain the candidate total.

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
- Open unknowns: current production domestic primary must be explicitly selected; result consumers that assume multi-node results; actual 10M discovery worker throughput/memory; 100k import and bulk mutation end-to-end behavior under the SQLite deployment profile.
- Complexity follow-up: the selection producer was extracted to `webui/backend/app/probe/selection_jobs.py`; `jobs.py` is now 1,125 lines. Helpers continue to receive the scheduler-owned connection, and do not create a second transaction owner.
- Slice result: backup lease transfer, unified current-result backend/LB/server views, stable groups, categorized-tag APIs/UI, signed IP cursor browsing, desktop fixed-selection/update/delete batch flows, backend selection-backed test jobs, desktop snapshot test creation, contextual facets, multi-group/tag filters, paged tag candidates, shared saved views, indexed measurement sorts, isolated 100万 storage acceptance, and 10M target planning/task creation smoke validation are complete; async high-volume import, 10万 end-to-end mutation acceptance, actual 10M scan throughput/memory, browser E2E for bulk update/delete progress, and full rollout migration remain unverified; no production writes or deployment occurred.
