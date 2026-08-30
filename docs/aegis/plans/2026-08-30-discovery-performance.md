# Discovery Performance Implementation Plan

**Goal:** Support up to 10,000,000 unique effective IPv4 discovery targets with bounded memory/task creation, efficient SQLite persistence, paginated discovery results, coordinated frontend behavior, and verified handoff documentation.

**Architecture:** Normalize targets/exclusions into merged integer intervals; lazily feed fixed async workers; send hits through a bounded batch-persistence owner; initialize SQLite once per path and open owner-local configured connections; expose server-filtered/sorted offset pages and separate facets; let the frontend render one page and explicitly manage cross-page IDs.

**Tech Stack:** Python 3, asyncio, sqlite3, FastAPI/Pydantic, unittest; React 19, TypeScript, Vite, Radix/shadcn.

**Baseline/Authority Refs:** `chat/PERF_OPT_HANDOFF_2026-08-29.md`, `chat/PROJECT_MEMO_2026-08-22.md`, current source/tests, `docs/aegis/baseline/2026-08-30-initial-baseline.md`, and the user-approved 2026-08-30 design.

**Compatibility Boundary:** Preserve production rows and unrelated control/LB/route behavior; retain scan concurrency 1..2000 and timeout 0.5..10; keep valid-ID import semantics and auto-route ordering (commit before enqueue); no global cross-thread SQLite connection; no production load tests or deployment. Coordinated frontend/backend migration may retire the old unbounded result and full-found status contracts.

**TDD Route:**
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Test posture: post-change regression
- Reason: strict TDD was not requested; use focused tests after each coherent slice.
- Verification: targeted unittest modules, full backend suite, TypeScript/build, bounded-structure evidence, review.

## Scope and readiness

**Requirement Ready Check:** approved source, scope, IPv4-only boundary, selection semantics, non-goals, and acceptance commands are explicit; no blocker questions. Decision: ready.

**Change Necessity:** configuration/documentation cannot remove eager address expansion, all-coroutine scheduling, repeated schema execution, unbounded API payloads, or full DOM rendering. Minimum code boundary is database + probe scanner/store/router + probe frontend API/types/page + tests. Decision: code-change.

**Architecture Integrity Lens:** canonical owners remain `control/database.py`, `probe/discover.py`, `probe/store.py`, `probe/router.py`, and Probe frontend modules. New helper types may be extracted from the 1,880-line page, but no duplicate persistence or scan owner is allowed. Persisted rows remain result truth. Verdict: aligned.

**Plan-Time Complexity Check:** `Probe.tsx` is already overgrown, so pagination state/data-fetch and the discovery panel should be extracted where this reduces render coupling. Database and scanner owners are compact enough for focused edits. Router/store changes stay in their existing owners. Result: at-risk unless Probe extraction is used.

**Plan Pressure Test:** owner and retirement boundaries are explicit; every slice has focused and full verification; rollback is source/schema-index compatible because added columns/indexes require no destructive data rewrite. Result: proceed.

## File map

- Modify `webui/backend/app/control/database.py`: initialization, connection settings, schema/index/migration support.
- Modify `webui/backend/app/main.py`: initialize before background services.
- Modify backend stores only as needed to use the split database API.
- Modify `webui/backend/app/probe/discover.py`: IPv4 interval parser, lazy iterator, bounded scheduler/status.
- Modify `webui/backend/app/probe/store.py`: paged queries/facets/chunked batches/selected-ID import support/batch upsert.
- Modify `webui/backend/app/probe/router.py`: paged/facets contracts and batched scan persistence orchestration.
- Modify `webui/frontend/src/lib/api.ts`, `types.ts`: coordinated API types.
- Modify `webui/frontend/src/pages/Probe.tsx`; create a focused discovery hook/panel under `webui/frontend/src/pages/probe/` only if extraction reduces the existing owner pressure.
- Modify/add backend tests: `test_database.py`, `test_discover.py`, `test_probe.py`, and lifespan coverage if needed.
- Update `chat/PERF_OPT_HANDOFF_2026-08-29.md` and Aegis evidence/checkpoint files.

## Task 1 — SQLite initialization and connection ownership

**Why:** Remove schema/migration work from every operation and make WAL/timeout/durability explicit without unsafe connection sharing.

**Impact/Compatibility:** Existing DB files migrate in place; all callers retain owner-local connections. WAL activation occurs only during controlled initialization.

1. Add `initialize_database(path)` with a per-process, per-resolved-path lock/set; create parent, open a raw connection, set and verify `journal_mode=WAL`, run schema/migrations/index creation, commit, close, and mark initialized only after success.
2. Make `connect_database(path)` ensure initialization for tests/non-app entry points, then open a fresh configured connection with row factory, FK on, explicit busy timeout and `synchronous=NORMAL`.
3. Prevent initialization recursion by separating the raw configured open helper from public connect.
4. Call initialization at the beginning of console lifespan before scheduler startup.
5. Remove store-constructor no-op initialization only if all test/CLI call paths remain covered; otherwise retain compatibility while ensuring it is O(1).
6. Add `tests/test_database.py` for one-time schema work, WAL persistence, per-connection PRAGMAs, distinct connections, retry after initialization failure, and basic reader/writer behavior.
7. Run `cd webui/backend && .venv/bin/python -m unittest tests.test_database tests.test_core -q` and the full suite.

## Task 2 — Lazy IPv4 intervals and bounded scanner

**Why:** Ten million targets cannot be represented as address strings or one coroutine per target.

**Impact/Compatibility:** IPv4 syntax and CIDR host semantics are preserved; IPv6 becomes an explicit validation error; cap changes to exact unique effective targets after exclusion.

1. Introduce immutable IPv4 interval/target-plan structures with merged inclusive ranges, exact count, and lazy string iteration.
2. Parse target and exclusion items directly to intervals; reject IPv6 and malformed/mixed ranges; preserve `/31` and `/32` current semantics.
3. Set `MAX_TARGET_IPS = 10_000_000`; reject only when the effective merged/subtracted count exceeds it.
4. Change `DiscoverState` to `found_count` and a fixed-size recent-hit deque; remove the unbounded `found` and `found_ips` owners.
5. Replace `gather` with a bounded address queue, one producer, and exactly `concurrency` workers; cancellation stops production and does not count unattempted addresses.
6. Define hit callback failure behavior: propagate persistence errors into state and terminate/drain safely rather than silently swallowing.
7. Expand `test_discover.py` for overlap/exclusion counting, exact 10M boundary, 10M+1 rejection, IPv6 rejection, lazy representation, bounded worker/queue count, cancellation, status shape, and callback failure.
8. Run `cd webui/backend && .venv/bin/python -m unittest tests.test_discover -q`.

## Task 3 — Store pagination, facets, chunking, and batch persistence

**Why:** Full-table reads and per-hit writes dominate at scale; arbitrary ID lists are a portability and transaction hazard.

**Impact/Compatibility:** Result items retain existing fields. Filtering/sorting becomes globally correct on the server. Batch operations keep duplicate/missing-ID semantics while becoming atomic.

1. Add or migrate a numeric IPv4 sort key column owned by discovery rows; backfill existing IPv4 rows transactionally and populate it on every upsert. Do not destroy unexpected legacy rows; place them deterministically after valid IPv4.
2. Add measured query-shape indexes for default discovered-time order, numeric IPv4 order, and exact group/label filters without adding FTS.
3. Implement a typed page query accepting page/pageSize (1..200), q, exact group/label, library status, sort, and order; use parameterized SQL, EXISTS for library status, count query, and stable ID tie-breakers.
4. Add a facets query for global nonempty labels/groups and imported/new counts.
5. Centralize ID normalization and chunk size based on `connection.getlimit(SQLITE_LIMIT_VARIABLE_NUMBER)` with parameter headroom.
6. Make discovery/server batch update/delete atomic across chunks and count unique affected rows.
7. Add selected-ID lookup/import support that never materializes the full result table.
8. Add scanner batch UPSERT in one transaction and return route-eligible addresses based on state observed in that transaction.
9. Expand `test_probe.py` for page metadata, every filter/sort/tie, facets, numeric IP order, lowered variable limit chunking, duplicate/missing IDs, rollback, selected import, and batch upsert.
10. Run `cd webui/backend && .venv/bin/python -m unittest tests.test_probe -q`.

## Task 4 — Router contracts and bounded persistence orchestration

**Why:** The HTTP and scan callback layers must expose bounded contracts and keep DB work off the scanner event loop.

**Impact/Compatibility:** `/discover/results` changes coherently with its sole frontend consumer; `/discover/facets` is new. Existing write endpoints retain route/audit behavior.

1. Define validated result query enums/limits and return `{items,page,pageSize,total,sort,order}`.
2. Add `/discover/facets`; remove labels from each result page response.
3. Update import and route-start paths to fetch only requested IDs.
4. Introduce a bounded hit persistence queue/writer owned for one scan; batch by count/time; the writer owns its connection/thread context.
5. Commit hits before enqueueing deduplicated auto-route IPs; flush on normal completion and stop; surface persistence failure in scan status.
6. Ensure only one active scan/writer lifecycle exists and reset/cleanup works in tests.
7. Add router-level tests for parameter validation, response contracts, final flush, stop, and persistence failure visibility.
8. Run targeted discover/probe tests, then the full backend suite.

## Task 5 — Frontend paged discovery workflow

**Why:** Backend pagination only helps if the browser stops fetching, processing, and rendering the whole table.

**Impact/Compatibility:** Existing filter controls remain, but are server-owned. Selection is explicit across pages; current-page select-all excludes imported rows.

1. Update `types.ts` with result page, facets, query, `foundCount`, and bounded recent-hit types; retire full `found` dependence.
2. Update `api.ts` to encode all result query parameters and expose facets.
3. Move discovery page state/fetch/poll behavior into a focused hook and/or panel under `pages/probe/` if needed; keep filter/page/selection state stable above conditionally rendered content.
4. Fetch one page, reset page on filter/sort/page-size changes, handle out-of-range pages after deletion, and refresh facets only after relevant mutations/terminal scan.
5. Use AbortController or request sequence to reject stale responses; use recursive timeout to prevent overlap; poll only when discovery tab and document are visible.
6. Remove client global filtering/sorting and the broken dotted-IP comparator path.
7. Implement explicit cross-page selected IDs; header checkbox affects only eligible current-page rows; imported rows are disabled and never synthesized into selection.
8. Render only the active large tab body; do not use global `forceMount`; avoid scan and route polling both refreshing discovery.
9. Run `cd webui/frontend && npx tsc -b && npm run build`.

## Task 6 — Integrated verification, review, and durable handoff

**Why:** Cross-layer performance changes need evidence beyond local correctness.

1. On an isolated temp DB, assert the resolved DB path is inside the temp directory; populate a bounded fixture directly and capture `EXPLAIN QUERY PLAN` for default and numeric-IP page queries.
2. Capture structural boundedness evidence: a 10M target plan has interval-sized storage; scanner task/queue counts depend on concurrency, not target count.
3. Run `cd webui/backend && .venv/bin/python -m unittest tests.test_database tests.test_discover tests.test_probe -q`.
4. Run `cd webui/backend && .venv/bin/python -m unittest discover -s tests -q`.
5. Run `cd webui/frontend && npx tsc -b && npm run build`.
6. Run `git diff --check` and inspect `git status --short`.
7. Request an independent code review covering architecture, correctness, data safety, cancellation/backpressure, API compatibility, frontend races, and test gaps; resolve high-confidence findings and rerun affected verification.
8. Update `chat/PERF_OPT_HANDOFF_2026-08-29.md` with corrected historical claims, implemented contracts, test/performance evidence, remaining risks, and no credentials.
9. Update `docs/aegis/work/2026-08-30-discovery-performance/20-checkpoint.md` and `90-evidence.md`; add reflection only at completion candidate.

## Execution Readiness View

- **Intent Lock:** bounded ten-million effective IPv4 discovery plus paged results and complete evidence.
- **Scope Fence:** no IPv6/distribution/resume/FTS/all-matching/deploy/production load.
- **Baseline Lock:** handoff + current code/tests + approved design + initial baseline.
- **Owner/Contract Constraints:** keep existing canonical owners; persisted rows are truth; SQLite connections are owner-local.
- **Compatibility Boundary:** data-preserving migration; unrelated APIs unchanged; result/status contracts migrate atomically with frontend.
- **Retirement Boundary:** remove eager list/set expansion, all-target gather, full-found status, per-hit synchronous DB callback, unbounded result UI path, and full-table import lookup.
- **Task Batches:** database; scanner; store/API; frontend; integrated verification/docs.
- **Test Obligations:** targeted modules, full 138+ backend suite, frontend type/build, isolated query-plan and boundedness evidence.
- **Review Gates:** architecture review after implementation and independent code review before completion.
- **Drift/Rewind Rules:** stop and return to design if a new public compatibility owner, destructive migration, production operation, or IPv6 requirement appears.
- **Evidence Required Before Completion:** commands and outputs, review disposition, updated handoff, clean diff checks.
- **Advisory Boundary:** method guidance only; not completion authority.

## Risks and rollback

- WAL may fail on unsuitable filesystems: initialization must fail explicitly rather than silently claim WAL.
- `synchronous=NORMAL` is an accepted throughput/durability tradeoff; rollback is a PRAGMA policy change.
- SQLite still serializes writers: bounded batching/backpressure controls pressure but does not create writer concurrency.
- Offset pages can move during live scans; this is accepted first-release behavior.
- Migration must tolerate existing rows and be tested only on copies/temp DBs.
- If frontend extraction expands beyond discovery ownership, stop and keep unrelated tab refactors out of scope.

## Execution route

Use subagent-driven execution for bounded backend and frontend slices, with the coordinator owning integration, overlapping router contracts, final verification, review disposition, and documentation. Fall back to inline execution if ownership overlap becomes unsafe.
