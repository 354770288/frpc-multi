# 服务器分类与大规模数据交互 Evidence

## Slice: durable selection snapshots and asynchronous update/delete

- `./.venv/bin/python -m unittest tests.test_probe_bulk tests.test_probe tests.test_probe_jobs tests.test_lb tests.test_lb_selection tests.test_database` — coordinator fresh run: 239 tests passed.
- `./.venv/bin/python -m py_compile app/probe/bulk.py app/probe/router.py app/probe/store.py app/control/database.py app/main.py tests/test_probe_bulk.py` — exit 0.
- `git diff --check` — exit 0.
- Spec compliance review: no P0/P1 findings; retry-after-expiry fix re-reviewed and passed. Selection-backed test-job creation remains a separate scope item because the existing ProbeJobStore eagerly expands targets.
- Code-quality review: cleanup/retry race found and fixed; re-review confirmed active retries preserve source job and failure rows through cleanup.

Selection snapshots now bind an owner, max server ID, filter set, and catalog revision at request acceptance. The background worker builds memberships in bounded 10,000-ID ranges and rejects the snapshot if filter-relevant catalog data changes during construction. Update/delete jobs materialize targets in bounded ranges, execute at most 250 server mutations per transaction, expose progress and cursor-paged failures, and retry failed rows from terminal source jobs. A lease token fences selection builds, bulk mutations, and outcome writes; deleted update targets become explicit failures. Cleanup advances in bounded pages and preserves source failure rows while queued/running retries depend on them. Retry remains possible after selection expiry during the seven-day terminal retention window.

At this backend-only slice boundary, the desktop had not yet consumed these APIs. Bulk probe-test creation remains deferred to a separate bounded task-producer slice; the 100k fixture verifies membership materialization, not full mutation completion under concurrent load; 1M capacity and production migration/deployment were not tested.

## Slice: desktop fixed selection and batch progress integration

- `npm run build` — exit 0; TypeScript and Vite production bundle passed.
- `npm test` — exit 0; 4 test files and 9 tests passed.
- `./.venv/bin/python -m unittest tests.test_probe_bulk tests.test_probe tests.test_probe_jobs tests.test_lb tests.test_lb_selection tests.test_database` — coordinator fresh run: 240 tests passed.
- `git diff --check` — exit 0.
- Spec compliance review: no remaining findings after adding label-filter parity, stale-search blocking, snapshot counts, and add-only snapshot tag controls.
- Code-quality review: no actionable correctness findings. Remaining test limitation: hook lifecycle is not mounted in tests, and no Playwright E2E was run for this slice.

The desktop sends the current filter snapshot (including legacy labels) without paging/sort values or expanded IP lists. Explicit selections remain separate and are capped at 5,000 IDs. Existing group, legacy-label, category-tag, and delete actions submit durable jobs; the page shows snapshot/job progress, paged failures, and failed-only retries. Freeze is disabled until the visible search, applied query, list, and count are current. Snapshot tag actions are add-only because the current UI lacks a snapshot-scoped attached-tag preview. Quick-test actions continue to use only manually selected IPs.

At the end of the desktop batch-integration slice, no E2E browser run had been performed; selection-backed probe-job creation and saved views were still pending; no full 100k mutation/concurrent-write benchmark, 1M capacity test, or production deployment had been performed.

## Slice: selection-backed probe-job target producer

- `./.venv/bin/python -m unittest tests.test_probe_selection_jobs tests.test_probe_jobs tests.test_probe_bulk tests.test_probe tests.test_database tests.test_lb tests.test_lb_selection` — coordinator fresh run: 253 tests passed.
- `./.venv/bin/python -m py_compile app/probe/jobs.py app/probe/router.py app/probe/bulk.py app/control/database.py tests/test_probe_selection_jobs.py` — exit 0.
- `git diff --check` — exit 0.
- Spec compliance review: P2 node deletion while materialized tasks remained was fixed by protecting saved-policy nodes until the job is terminal; stop-after-materialization retry retention was fixed and re-reviewed with no remaining findings.
- Code-quality review: no blocking findings.

The `/api/probe/jobs` selection scope accepts a selection ID, mode, options, and idempotency key, not IP arrays. Creation atomically checks owner/readiness/expiry, primary policy, capabilities, and port 7000. A producer record stores its cursor, saved owner, generation, and progress. Claims create up to 250 tasks per transaction while limiting active backlog to 500. The job stays running until both target production and all generated tasks finish. Failover transfers the producer cursor and pending tasks using the job's policy snapshot; zero-task failover, partial sweeps, wait/resume, monotone cursor, stop/retry, owner deletion, and 100k bounded generation have regression coverage.

At the end of the producer-backend slice, the frontend had not yet created tests from saved selection snapshots; no end-to-end 100k task execution/concurrent write benchmark, 1M capacity test, browser E2E for the new selection flow, or production migration/deployment had been performed.

Complexity control: initial producer implementation crossed the 1,200-line strong pressure signal in `jobs.py`; this was governed by extracting cohesive creation/materialization/failover helpers into `selection_jobs.py`. `jobs.py` is now 1,125 lines. The scheduler remains the sole transaction owner and passes its open connection into helpers; quality review confirmed no import cycle or second persistence owner. Complexity closure for this pressure signal: `exceeded-and-governed`; defer further extraction unless line pressure returns.

## Slice: desktop selection-backed test creation

- `npm run build` — exit 0; TypeScript and Vite bundle passed.
- `npm test` — exit 0; 4 files and 9 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — coordinator fresh run: 32 Playwright tests passed.
- `git diff --check` — exit 0.
- Spec compliance review: Back/Forward state restoration, no duplicate snapshot POST, snapshot-only submission, group/all no-IP expansion, 5,000 explicit target cap, and producer waiting progress passed.
- Code-quality review: no actionable findings.

The Server Library snapshot now links directly to TestCreatePage. Group/all scopes create and poll a fixed server selection; deep links load the existing owner-bound snapshot. Test submission uses `targetScope='selection'`, selection ID, and an idempotency key without `ips` or `nodeIds`. The UI preserves uncertain submissions across reload, shows snapshot count/state/expiry, displays producer target materialization and backup-waiting status, and restores scope/group/mode from URL navigation. The manual endpoint textarea and previous explicit selection are limited to 5,000 targets; larger sets are directed to a frozen server snapshot.

Uncovered: E2E for asynchronous batch update/delete UI progress and failure retry; exactly-5,000 boundary is accepted by implementation but only 5,001 rejection has browser coverage; no full 100k task execution benchmark, 1M capacity test, or production deployment.

## Slice: contextual server facet counts

- `./.venv/bin/python -m unittest tests.test_probe_contextual_facets tests.test_probe_selection_jobs tests.test_probe_jobs tests.test_probe_bulk tests.test_probe tests.test_database tests.test_lb tests.test_lb_selection` — coordinator fresh run: 257 tests passed.
- `./.venv/bin/python -m py_compile app/probe/store.py app/probe/router.py tests/test_probe_contextual_facets.py` — exit 0.
- `git diff --check` — exit 0.
- Spec compliance review: counts exclude only their own dimension, use full service-side matching sets, preserve stable IDs and no-argument response compatibility.
- Code-quality review: no actionable findings.

The facets endpoint now accepts q, legacy label, group, group IDs, tag ID, include/exclude IDs, any/all tag mode, and connectivity state. Group counts omit group constraints but retain all other filters; tag/category and legacy label counts omit tag constraints but retain search, grouping, and connectivity constraints. The 100k SQL aggregate test confirms one statement per facet dimension, indexed lookup of `probe_current_results` on `(server_ip, kind, port)`, and no read of history tables.

At the end of the backend contextual-facet slice, the frontend had not yet exposed multi-group/include-any/include-all/exclude controls; indexed measurement sort modes and saved views remained planned; the query-plan assertion used a synthetic 100k fixture without claiming a latency SLA or concurrent-write result; no production deployment was performed.

## Slice: opt-in paged tag candidates

- `./.venv/bin/python -m unittest tests.test_probe_contextual_facets tests.test_probe_selection_jobs tests.test_probe_jobs tests.test_probe_bulk tests.test_probe tests.test_database tests.test_lb tests.test_lb_selection` — coordinator fresh run: 258 tests passed.
- `./.venv/bin/python -m py_compile app/probe/store.py app/probe/router.py tests/test_probe_contextual_facets.py` — exit 0.
- `git diff --check` — exit 0.
- Spec review: no-argument calls return the full previous facet result; explicit search/page requests return stable bounded candidates and unchanged contextual counts.
- Code-quality review: query bounds, escaped search and empty-page totals passed; page overflow above one million is rejected before SQL.

The facets API adds opt-in category/name search, page, and page-size parameters. It returns a 50-item first page by default only when paging/search is explicitly requested; no-argument callers preserve the prior unpaged candidate list and response keys. Results are stably ordered by category/name/tag ID, search escapes wildcard characters, and empty pages retain total metadata. The synthetic 100k EXPLAIN checks `LIMIT/OFFSET`, indexed search in the unified current-result projection, and no history-table scan.

At the end of the backend tag-pagination slice, the frontend had not yet passed tag search/page state, so its advanced controls still used the no-argument full facet list. The following desktop slice connected candidate search/pagination; indexed measurement sorts, saved views, capacity benchmarks and production deployment remain pending.

## Slice: desktop tag candidate search and pagination

- `npm run build` — exit 0; TypeScript and Vite bundle passed.
- `npm test` — exit 0; 5 files and 11 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — coordinator fresh run: 34 Playwright tests passed.
- `git diff --check` — exit 0.
- Spec compliance review: candidate search/paging is separate from applied filters; stable IDs and legacy no-argument facet behavior remain; no server asset expansion occurs.
- Code-quality review: requests use a complete filter/search/page key with cancellation and stale-response fencing; quick-tag conflict with excluded tags is resolved; no remaining findings.

The advanced filter area and quick-tag cloud now consume an explicit 50-item candidate page from contextual facets. Search is case-insensitive and scoped to category/tag names; next/previous and matching total are visible. Changing applied server filters or candidate search resets the candidate page; selected include/exclude IDs are preserved, and toggling unrelated quick tags does not clear other exclusions. URL/history continues to persist only applied filters, not candidate browsing state.

Uncovered: no virtualization study for extremely large tag dictionaries; indexed measurement sorts, saved views, scale timing/throughput, 100k mutation/task completion benchmark, 1M capacity, and production deployment remain pending.

## Slice: desktop multi-group and contextual tag filters

- `npm run build` — exit 0; TypeScript and Vite bundle passed.
- `npm test` — exit 0; 4 files and 9 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — coordinator fresh run: 33 Playwright tests passed.
- `git diff --check` — exit 0.
- Spec review: stable-ID group union, mutually exclusive single/multi group state, include-any/all, exclusions, URL history, and contextual counts passed.
- Code-quality review: quick-tag selection removes only a conflicting exclusion and preserves other excluded tags; no remaining findings.

Advanced controls use server facets and stable IDs; no browser-side asset expansion was added. Facet requests follow active filters and cancel stale requests; the interface marks counts unavailable while loading and exposes retry on errors. Quick-tag chips, the single-group shortcut, and manual filtering remain usable.

Uncovered: the frontend has not yet connected candidate search/pagination, so large tag dictionaries are not yet bounded in the filter UI. Indexed measurement sort modes, saved views, large-data timing/load tests, browser E2E for async bulk update/delete progress, and production deployment remain unverified.

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

The full scale target, classification/filter/query redesign, 100k acceptance data, 1M stress, 10M scan throughput/memory, and production deployment remain unverified.

## Slice: unified server views and source-free daily UI

- `./.venv/bin/python -m unittest tests.test_probe_jobs tests.test_probe tests.test_lb` — exit 0; 174 tests passed after route enrichment port isolation.
- `npm run build` — exit 0.
- `npm test` — 2 files, 3 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — 18 Playwright tests passed, including legacy URL preservation, no daily source selector/cross-node comparison, LB primary summary, and history source retention.
- `git diff --check` — coordinator will rerun before commit.
- Independent backend review found and fixed route enrichment still reading per-node history, plus a 7001/7000 endpoint mix-up. The final re-review confirmed the fix.

`ProbeStore` server list, filtered status, and dashboard views now read the unified route/connectivity/speed projection regardless of legacy node query parameters. Route status enrichment is limited to the exact fixed-7000 endpoint. Legacy Console rows stay available in history, while current views show untested until the configured primary has a projection. Discovery observations remain keyed by actual executing node. Daily server and LB pages no longer offer result-source selection, and cross-node comparison controls are removed; historical results still retain per-node filtering and provenance.

## Slice: stable business-group identity

- `./.venv/bin/python -m unittest tests.test_probe_jobs tests.test_probe tests.test_lb` — exit 0; 178 tests passed.
- `git diff --check` — coordinator will rerun before commit.
- Independent spec/quality reviews found and drove fixes for ID-based batch assignment display values, ID-based group filters, and repeated full-table startup scans; final review found no remaining P-level findings.

Added UUID group IDs and nullable references on assets, discovery candidates, and LB domains. A one-time transactionally marked migration maps every legacy group name to a stable ID; failed migration leaves the marker unset for retry, and completed startups avoid re-scanning group-name columns. Existing name-based APIs remain compatible, while list/assignment/rename/color/delete/domain APIs accept and expose IDs. Rename preserves the group ID and updates legacy display-name projections. Deletion returns HTTP 409 while assets, discovery results, or LB domains reference the group. LB domain selection and sync continue to use the same group after rename.

At that checkpoint, categorized tag relations, separation of manual tags from route measurements, scalable cursor/filter APIs, and large-data performance remained unimplemented. The following slice records the backend tag schema and API work.

## Slice: categorized tag API and assignment

- `./.venv/bin/python -m unittest tests.test_lb_selection tests.test_probe_jobs tests.test_probe tests.test_lb tests.test_database` — coordinator rerun: 219 tests passed.
- `python -m py_compile` on touched backend modules — exit 0.
- `git diff --check` — coordinator will rerun before commit.
- Independent spec/quality reviews found and drove fixes for category ambiguity, startup marker locking, stale compatibility reads, write serialization, duplicate projection labels, route-like manual label preservation, and import bounds. Final review confirmed the synchronous import cap.

Added stable category/tag CRUD and tag merge/move semantics, asset assignment by tag ID on create/update/batch, category-specific `tagItems` facets and `tagId` filtering, and legacy name-projection compatibility. Existing labels migrate to `other`, and retained tag IDs/categories survive old name-based edits. The legacy projection deduplicates tag names when the same name exists in more than one category. The exact route-like strings CN2, 非CN2, and 未路由测试 are preserved as manual labels when historical provenance is ambiguous; accepted route measurements remain in the separate current-result projection. Synchronous text import rejects requests over 5,000 entries or 1 MiB with HTTP 413 before parsing/writes; asynchronous high-volume import/progress remains a later slice.

The desktop category/tag management and multiselect UI, cursor pagination and contextual facets, server-side selection snapshots, and 100k/1M performance runs remain pending.

## Slice: cursor browsing and desktop categorized tags

- `./.venv/bin/python -m unittest tests.test_lb_selection tests.test_probe_jobs tests.test_probe tests.test_lb tests.test_database` — exit 0; 225 tests passed.
- `npm run build` — exit 0.
- `npm test` — 2 files, 3 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — 26 Playwright tests passed, including stable-ID tag CRUD/merge, legacy label compatibility, cursor pages/count separation, browser back/forward, sort fallback, delayed count responses, and error states.
- Query-plan coverage verifies ASC/DESC non-null cursor range `SEARCH` on `(ip_sort,id)`, indexed NULL-tail lookup, and no full scan or TEMP B-tree sort.
- Final code review confirmed the URL/error-state fixes and planner-friendly cursor seek.
- `git diff --check` — coordinator will rerun before commit.

The server library now uses filter-bound, HMAC-signed keyset cursors for IP sort and loads exact counts separately. The cursor endpoint validates payload shape, caps ID-filter lists, and rejects non-IP sort requests; other sort modes keep the compatible offset endpoint. Browser URL history restores cursor pages, and page/count failures preserve last data without rendering false zero/empty states. The desktop UI groups tags by category, manages categories/tags by stable IDs, and supports tag-ID filters and bulk assignment.

Current limits: multi-group and include-all/any/exclude controls are available at the API but not fully exposed in the UI; contextual facet counts, indexed measurement sort modes, saved views, server-side selection snapshots, asynchronous 100k import/batch jobs, and 100k/1M performance runs remain pending.

## Slice: unified current-result projection foundation

- `./.venv/bin/python -m unittest tests.test_probe_jobs tests.test_lb tests.test_probe` — exit 0; 171 tests passed after final migration and LB query fixes.
- `git diff --check` — coordinator rerun before commit.
- Spec review identified and fixed invalid primary/backup policy seeding, fixed-port LB lookup, stale projection after history clearing, and unscoped projection reads. Final focused seed review found no remaining P-level issue.

Added a durable current-results projection for route, connectivity and speed. It seeds once from the first fully valid configured primary, preserves current rows across later policy changes, and only updates from accepted primary-managed reports (including accepted backup failover work). Each row retains its canonical history ID and actual node/job/task/generation/time. History clearing removes matching projection rows in the same transaction. LB keeps its health, freshness and ranking rules, reads the unified projection for candidates in the domain group, and uses fixed test port 7000 regardless of frpc instance settings. The source-free read API is available; old source-scoped history APIs remain during caller migration.

Server-library status/query views and UI source-selector retirement remain the next dependent slice. Full-scale data tests and production migration remain unverified.
