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

## Slice: Console-shared saved server views (backend)

- `cd webui/backend && ../../.venv/bin/python -m unittest tests.test_probe_saved_views tests.test_probe_contextual_facets tests.test_probe_selection_jobs tests.test_probe_jobs tests.test_probe_bulk tests.test_probe tests.test_database tests.test_lb tests.test_lb_selection` — exit 0; 261 tests passed.
- `python -m py_compile` on the saved-view store, probe router, and control database — exit 0.
- `git diff --check` — exit 0.
- Spec review found one malformed-filter type path that could return 500; explicit string checks and API regressions now verify 400 for non-string `conn` and `tagMode`.
- Final quality review passed with no P0–P2 findings.

Added a Console-wide shared saved-view collection with authenticated list/create/patch/delete routes, case-folded unique names, validated filters, stable group/tag ID support, explicit sort and visible-column whitelists, and a 16 KiB payload bound. Pagination cursors and selections are excluded by the filter schema. The database change is additive and initialization-safe.

## Slice: saved server views (frontend)

- `npm run build` — exit 0.
- `npm test` — 6 files, 14 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — coordinator rerun: 38 tests passed.
- E2E covers shared view CRUD, stable-ID filters, sort and visible columns, URL restoration, debounce-window save, stale list responses, duplicate mutations, edits during delayed create, and rapid save from page/cursor URLs.
- Independent spec and quality reviews passed after fixes for URL search restoration, request races, and pagination-only draft signature changes.
- `git diff --check` — exit 0.

The server library now loads shared views, saves its persistent filter/sort/column draft, and supports rename/delete. Applying a view restores filters and sorting into the URL while resetting page/cursor; selections remain separate. Delayed requests preserve edits made while create is pending, and older list reads cannot replace later CRUD results.

## Slice: indexed speed/time sorting (backend)

- `PROJECT_DIR=/tmp/frpc-multi-backend-verified DATABASE_PATH=/tmp/frpc-multi-backend-verified/console.db ./.venv/bin/python -m unittest tests.test_probe_saved_views tests.test_probe_contextual_facets tests.test_probe_selection_jobs tests.test_probe_jobs tests.test_probe_bulk tests.test_probe tests.test_database tests.test_lb tests.test_lb_selection` — exit 0; 264 tests passed.
- `cd webui/backend && ./.venv/bin/python -m unittest tests/test_probe_jobs.py` — exit 0; 74 tests passed.
- `cd webui/backend && ./.venv/bin/python -m unittest tests/test_probe.py` — exit 0; 99 tests passed.
- Query-plan regression tests run the complete server-list SELECT/JOIN in both directions; speed uses `idx_probe_servers_speed_sort_id`, time uses the matching ASC/DESC expression index, and neither plan has `TEMP B-TREE FOR ORDER BY`.
- 100,000 mixed raw IPv4, `:07000`, domain, and IPv6 assets with current speed rows loaded in 6.49 s including triggers and indexes. Projection backfill took 0.77 s; first-page `query_servers` timings were 3.33 ms (speed ASC), 1.78 ms (speed DESC), 1.70 ms (time ASC), and 1.63 ms (time DESC).
- The backfill `EXPLAIN QUERY PLAN` uses the current-results primary-key index for each correlated row lookup (`server_ip=? AND kind=? AND port=?`); result-trigger asset updates use `idx_probe_servers_current_host`.

Added rebuildable `speed_sort` and nullable `time_sort` columns to the asset catalog. Initialization backfills them once from fixed-port current speed rows; transactional triggers maintain them for current-result insert/update/delete and asset insert/IP changes. Projection matching now follows the server-list host join for canonical IPv4, domains, and IPv6, including zero-padded port forms such as `:07000`; an expression index keeps trigger-side asset lookup indexed. Zero-speed and NULL-last ordering semantics are preserved. No older speed/time projection triggers were present to retire. Triggers use `IF NOT EXISTS`, so repeat initialization does not drop/recreate them.

## Slice: isolated 1M storage capacity acceptance

- Fixture: 1,000,000 assets (80% IPv4, 10% domains, 10% IPv6), 64 groups, 32 tags, and 7,000 current-result rows (3,500 connectivity, 3,500 speed), seeded in an isolated temporary SQLite database from the prior schema.
- Host: macOS 26.5 ARM, 10 CPU cores, 16 GiB RAM; Python 3.14.2 and SQLite 3.51.2. Temporary databases were removed after verification.
- Seeding: 1.47 s. Full `initialize_database()` migration: 34.395 s CPU 33.702 s; peak RSS 232.5 MiB; migrated DB+WAL 523,259,904 bytes (~499 MiB). Post-migration process RSS ~52 MiB.
- `/servers` offset first page for IP/speed/time sorts (50 rows plus total): each about 4–5 ms. `count_servers()` for all assets: 3 ms. `count_servers(conn="pass")`: 1.465 s for 3,500 matching assets. Filtered `server_facets()`: 1.612 s.
- All-match selection snapshot: 100 `run_once()` calls of 10,000 rows, 0.685 s total for 1,000,000 rows. Selection-backed scheduler materialized a 250-target batch in 4 ms.
- Current frontend IP cursor endpoint on a separate 1M IPv4 fixture: 50-row first page in 1.6 ms, `hasMore=true`; EXPLAIN uses `idx_probe_servers_ip_sort_id` and current-result primary-key lookups.
- These measurements call the real storage methods and SQLite query plans, not HTTP, auth, browser, or production infrastructure. The `conn="pass"` count and contextual facets scan the full asset set and are materially slower than unfiltered count/list pages; the migration process RSS includes the one-time label normalization path.

The isolated 1M storage acceptance passes for migration, paging, counts, facets, bulk-selection construction, and bounded task production. This does not cover production latency or end-to-end 100k import/update/delete UI operations.

Plan coverage limit: this run includes 7,000 current rows, not 9 historical rows per asset across three test kinds; it is a single-process storage-method run, not the plan's 5 concurrent readers with sustained writes; and it does not report P50/P95, cold/warm cache repetitions, 10M scan input, or full import/update/delete browser flows. The 1M table should therefore be read as an isolated capacity smoke test, not as completion of all performance release gates.

## Slice: 10M target planning and task creation smoke test

- Synthetic range `100.64.0.0–100.216.150.127` resolves to one disjoint IPv4 interval containing exactly 10,000,000 targets.
- `parse_targets()` took about 70 µs with a `tracemalloc` peak of 1,112 bytes; consuming the first 16 generated addresses did not expand the plan.
- Isolated `ProbeJobStore.create_job('discover', ...)` took about 1.9 ms, set total=10M, and created exactly one pending discover task. The task payload was 96 bytes and held only interval bounds, cursor, chunk bounds, and size; the initial chunk was 4,096 addresses.
- At initial job creation, task IP/error fields were empty and `probe_results`, `probe_discover_results`, and `probe_discover_observations` each remained at 0 rows.
- No network scan ran. This validates compact target planning and first-chunk persistence only; worker throughput, queue/RSS during a full synthetic scan, successful-hit growth, and cancellation/restart recovery remain open.

## Slice: 10M bounded discovery worker smoke

- Ran a full 10,000,000-target `DiscoverRunner` interval through the real producer, bounded `asyncio.Queue`, worker pool, and progress counters. `asyncio.open_connection` was replaced with an immediate `OSError` coroutine; no network connection was attempted.
- Runtime: 39.728 s wall / 38.720 s CPU (about 251,713 targets/s) with 2,000 workers; queue capacity and observed peak were both exactly 2,000.
- All 10,000,000 targets were counted as scanned; `found=0`, error empty. `discover_results`, `discover_observations`, `probe_results`, and recent hit buffers remained at 0 entries.
- Peak RSS was 37.7 MiB (raw `ru_maxrss` 39,550,976 bytes). Runner thread exited; `reset()` cleared state and left no scanner thread. Temporary database was removed.
- This isolates worker/queue/progress overhead for immediate failures. It does not emulate destination-network latency distributions, successful-hit result growth, concurrent SQLite readers/writers, or production host hardware.

## Slice: asynchronous import and bulk mutation acceptance

- Import contract retains the old synchronous API limit. New authenticated import jobs cap raw text at 16 MiB, request body at 17 MiB, endpoints at 100,000, and each default/row group at 128 Unicode characters and 512 UTF-8 bytes. A single shared bulk-worker lease stages at most 1,000 parsed rows per pass and writes assets in 250-row transactions.
- Existing assets and duplicate input are skipped without changing the existing asset’s group/tags. Invalid address/group rows remain visible as permanent failures; transient write failures are marked retryable. Status reports `retryableFailed`; failure pages identify each row’s retryability; retry jobs include only retryable failures. Idempotency, lease recovery, malformed JSON, Unicode surrogate and nonstandard JSON numeric values, owner isolation, and seven-day bounded terminal cleanup have regression coverage.
- Backend coordinator suite with a writable isolated `PROJECT_DIR`/`DATABASE_PATH`: `tests.test_probe_import_api`, `test_probe_bulk`, saved views, contextual facets, selection jobs, probe jobs, probe, database, LB, and LB selection — 277 tests passed. This includes HTTP TestClient checks for auth/owner scope, idempotency, progress, failed-row pagination, malformed inputs, Unicode surrogate handling, nonstandard JSON numbers, and retryable-only replay.
- `python -m compileall` on the modified backend import/parser/store/router modules and `git diff --check` — exit 0.
- 100,000-row async import runs through parsing, staging and insertion in about 14 s in the isolated SQLite test fixture; existing assets, duplicate inputs and malformed rows are covered separately.
- 100,000-asset bulk update (group/tag) completed in 401 worker passes and 6.644 s; selection snapshot took 0.090 s. All 100,000 targets were processed successfully and group/tag relations were verified.
- 100,000-asset bulk delete completed in 401 worker passes and 4.647 s; selection snapshot took 0.083 s. All 100,000 targets were processed and the asset catalog was empty afterward.
- Mutation fixture SQLite file sizes after operation were 87,728,128 bytes (update) and 55,918,592 bytes (delete); WAL/SHM files were 0 after connections closed. Combined-process peak RSS was ~34.7 MiB on macOS ARM/Python 3.14/SQLite 3.51.2. Temporary databases were removed.
- `npm run build` and `npm test` — exit 0; 7 Vitest files / 15 tests passed.
- `npm run test:e2e -- e2e/test-creation.spec.ts` — 47/47 passed, including async import progress/recovery/failure paging/retry, bulk update progress/partial failure/retry, bulk delete progress, saved views, and browser URL history.
- The 100k mutation runs use a synthetic single-process SQLite fixture and do not include historical results, concurrent production I/O, production hardware, or HTTP/browser latency. They are end-to-end worker smokes, not the plan’s concurrent P50/P95 capacity certification.

The async import backend and UI now share the existing bulk lease/worker; no second scheduler owner was introduced. Browser state persists pending request bodies and idempotency keys before POST, restores jobs after reload/navigation, isolates stale responses by job ID, and exposes only retryable failures to retry actions.

## Slice: 100k concurrent read/write acceptance and indexed connectivity filters

- Fixture: 100,000 assets, 16 groups, 32 tags / 100,000 tag links, 900,000 historical results (three test kinds × three rounds per asset), and 300,000 current projections (route/connectivity/speed for every asset). This run exercises dense current status together with full history.
- Host: macOS 26.5 ARM, 10 cores, 16 GiB RAM; Python 3.14.2, SQLite 3.51.2. Isolated temporary database removed after the run.
- Workload: five concurrent readers issuing actual `ProbeStore` list/count/facets calls plus one writer updating current results and adding immutable history for 30.446 s; 2,035 writer commits and 6,105 additional history rows; zero SQLite busy/errors.
- P50/P95: filtered list page 14.1/18.8 ms; filtered count 12.6/16.5 ms; global facets 235.4/272.1 ms; tag+conn facets 84.4/106.4 ms; group+tag+conn facets 28.8/39.1 ms; write transaction 13.5/17.8 ms.
- Database: initial fixture+WAL+SHM 575.1 MB; end main database 563,167,232 bytes. Process CPU 135.031 s; sampled RSS peak 97.2 MiB, end 96.3 MiB.
- Query plans: connection filters search `idx_probe_servers_conn_score` or `idx_probe_servers_group_conn_score`; filtered pages use the group/connection composite index and tag filters use the server/tag primary-key index. Filtered page still uses a temporary B-tree for final sort and facets retain temporary grouping; observed latency remains below the 500 ms 100k target. Global facets also remain below 500 ms.
- Root cause / change: the previous path recalculated the connectivity score from current-result JSON per asset and joined the result projection for count/facets. A rebuildable `probe_servers.conn_score` projection now derives from the authoritative `probe_current_results`; migration/backfill and same-transaction triggers maintain it, and filters/count/order plus facets use indexed scores. The current-result projection remains the display/read source.
- Before this projection was added, the same workload measured tag+conn facets P95 4.52 s, group+tag+conn 1.79 s, and filtered page 507 ms. Afterward these measured 106 ms, 39 ms, and 19 ms respectively.

This closes the 100k concurrent read/write P50/P95 gate for the measured fixture. The 1M facets/list concurrency smoke is recorded below; full 1M 3×3 history/current density, actual destination-network timing distributions, production migration/rollback, and deployment checks remain open.

## Slice: indexed connectivity score and final 100k dense reprobe

- `probe_servers.conn_score` is a rebuildable 0–4 projection derived only from `probe_current_results` for connectivity:7000. Migration backfills once; same-transaction current-result insert/update/delete and asset insert/IP changes maintain it. `ProbeStore` filters, exact counts, conn sorting and contextual facets use the materialized score; list display continues to read the current-results projection.
- Anti-entropy review: the old per-row JSON score expression was retired from filter/count/order hot paths. The current-results projection remains the sole business result source; the new asset column is derived state. No live rows were deleted.
- Indexes cover `(conn_score,id)` stable status sorting, `(conn_score,server_group,ip-order...)`, and `(group_id,conn_score,server_group,ip-order...)`. EXPLAIN confirms conn sorting uses its index without ORDER BY temp B-tree; contextual facets point-query tags through the `(server_id,tag_id)` primary key.
- Final fixture: 100k assets, 900k immutable history rows (three kinds × three rounds per asset), 300k current projections (all three kinds for every asset), and 100k tag links. Host macOS 26.5 ARM, 10 CPU cores, 16 GiB; Python 3.14.2 / SQLite 3.51.2.
- 30.476 s with five read threads and one writer. The writer alternated the same connectivity projection between scores 4 and 1 to exercise conn index updates; 1,959 commits / 5,877 history rows; busy/errors=0. Write-transaction P50/P95 14.0/18.1 ms.
- Query P50/P95: filtered page 14.4/19.0 ms; filtered count 12.7/16.6 ms; global facets 236.2/266.5 ms; tag+conn facets 81.5/92.4 ms; group+tag+conn facets 29.7/40.5 ms; IP/speed/time first page P95 25.4/25.9/25.7 ms. All measured 100k query P95 values meet the 500 ms target.
- DB+WAL+SHM at seed: 576,523,648 bytes; main DB after the run: 564,531,200 bytes. Sampled RSS peak 100.6 MiB, end 84.9 MiB.
- A prior pre-score run measured tag+conn facets P95 4.52 s and group+tag+conn 1.79 s. After materialization, the first dense run measured 106/39 ms; after adding the conn-sort tie-break index, this final run measured 92/41 ms. The additional index kept write/query latency close to the prior dense run.
- Final related backend suite after conn-score/index changes: 280 tests passed. Independent spec and quality reviews found no P1/P2 issue in the projection, triggers, or indexes.

The concurrent 100k release target is met for this synthetic full-history/dense-current fixture. The 1M smoke below covers high asset/tag/current-connectivity density, while full 1M multi-kind history/current density, actual destination-network distributions, and production migration/rollback remain open.

## Slice: 1M facets/list concurrency smoke

- Fixture: 1,000,000 assets, 1,100,000 tag links, and 500,000 connectivity current/history rows; five reader threads and one writer over 30 s. This is a sparse projection workload, not the full 3,000,000 current / 9,000,000 history profile.
- Host: macOS 26.5 ARM, 10 CPU cores, 16 GiB RAM; Python 3.14.2 / SQLite 3.51.2. Fixture seed took 79.170 s; temporary data was removed after testing.
- P50/P95: global facets 1.03/1.78 s; tag+conn facets 730/840 ms; group+tag+conn 141/224 ms; filtered page 8.2/12.6 ms; exact filtered count 7.3/11.7 ms.
- Writer submitted 3,066 transactions and 9,198 history rows; write transaction P50/P95 was 8.5/12.5 ms. Busy/errors=0. RSS peak 93.5 MiB; DB+WAL peak about 1.36 GB; final main DB 1,044,963,328 bytes.
- Global facets used the tag-first covering index; tag+conn used `conn_score`; group+tag+conn used the group/conn index. All measured candidate facet/count paths are below the 1M 3 s count target; list pages are below the 1M 800 ms list target. The full-density 1M history/current profile remains unmeasured.

## Slice: full-density 1M history/current concurrency acceptance

- Fixture: 1,000,000 assets, 1,000,000 tag links, 3,000,000 current projections (1M each for route/connectivity/speed), and 9,008,478 history rows (9M initial plus 8,478 from the writer). Five reader threads and one sustained writer ran for 31 s. Fixture seed took 255.790 s; total run was about 287 s.
- Host/runtime: macOS 26.5 ARM, 10 CPU cores, 16 GiB RAM; Python 3.14.2 / SQLite 3.51.2. Temporary DB was removed after the run.
- Read P50/P95 (ms): IP sort 24.82/40.58 (n=1,119); speed 25.30/41.30 (n=1,099); time 24.74/39.63 (n=1,116); filtered page 9.13/15.18 (n=1,894); filtered count 7.96/13.45 (n=1,894); global facets 1,009/2,306 (n=11); tag+conn facets 1,249/1,960 (n=10); group+tag+conn facets 313/882 (n=10).
- Writer: 2,826 transactions and 8,478 history rows; transaction P50/P95 9.84/15.18 ms. SQLite busy/errors=0. DB+WAL peak 5.5185 GB (<6 GiB); final main DB 5,169,184,768 bytes with WAL checkpointed; RSS peak 70.9 MiB (<2 GiB).
- EXPLAIN: ordinary IP/speed/time first pages use their sort indexes. Filtered page/count use group/connectivity indexes and tag primary-key lookups; filtered pages retain a temporary B-tree for final sort. Global facets use the tag-first covering index; legacy name aggregation retains a temporary B-tree for grouping/`COUNT(DISTINCT)`. Tag+conn materializes candidates through `idx_probe_servers_conn_score_id`; group+tag+conn uses `idx_probe_servers_group_conn_score`.
- The measured list, count, and facets remain within the plan's 1M thresholds (800 ms list, 1.5 s complex list filter, 3 s candidate/exact counts). Facet sample counts are small (10–11), so those P95 estimates need cautious interpretation. This closes the full-density synthetic 1M concurrent storage/query gate; it does not substitute for destination-network timing distributions or production migration/rollback preflight.
