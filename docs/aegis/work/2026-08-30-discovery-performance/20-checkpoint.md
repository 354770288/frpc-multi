# Todo Checkpoint

- Completed: baseline/handoff audit; approved design/plan; Task 1 SQLite lifecycle; Task 2 bounded lazy scanner; Task 3 discovery migration/paging/facets/chunking/batch UPSERT; Task 4 paginated HTTP contracts, selected-ID consumers, and bounded persistence-writer orchestration; Task 1–4 specification and quality review loops; Task 5 frontend paged discovery workflow (spec + quality reviews passed).
- Active slice: Task 5 scoped commit, then Task 6 integrated verification/review/docs.
- Pending: Task 6 EXPLAIN/boundedness evidence, independent comprehensive review, doc closeout (checkpoint/evidence/handoff/99-reflection).
- Evidence: Task 1 commit `e2b1f6a`; Task 2 commit `78cc4e4`; Task 3 commit `0e5b2c3`; Task 4 commit `dd42848`; Task 5 working-tree verification: `npx tsc -b && npm run build` exit 0; retirement greps clean (no discoverFiltered/loadDiscover/scanStatus.found/discovery setInterval in frontend discovery paths); first review verdict "With fixes" → fixed 1 Critical (terminal-transition miss via hook-level refs + nudge setters) + 4 Minor; second independent review verdict "Yes" with one consistency nit (import onDone recoverOutOfRange) fixed; `git diff --check` clean.
- Blocked on: nothing.
- Next: create scoped Task 5 commit, then Task 6 per plan.

## ResumeStateHint

Read the plan, this checkpoint, `chat/PERF_OPT_HANDOFF_2026-08-29.md`, and `git status`; do not touch production DB, deploy, or let subagents mutate Git lifecycle state. Task 5 is implemented and review-approved (hook `pages/probe/useDiscovery.ts` mounted above conditional tab content); do not restore browser-global discovery filtering/sorting or a second polling owner.

## Slice Card

- Goal: expose bounded paginated discovery contracts and persist scanner hits through one scan-scoped bounded writer while preserving failure visibility, stop/start safety, transactional import authority, and commit-before-route ordering.
- Parent plan/spec: Task 4 in `docs/aegis/plans/2026-08-30-discovery-performance.md`.
- Files: `webui/backend/app/probe/discover.py`, `webui/backend/app/probe/persistence.py`, `webui/backend/app/probe/router.py`, `webui/backend/app/probe/store.py`, `webui/backend/tests/test_discover.py`, and `webui/backend/tests/test_probe.py`.
- Boundary: no frontend changes; persisted discovery rows remain canonical truth; one `DiscoverScanCoordinator` and one writer/connection owner per scan; no router import preflight or old full-list/singular-upsert production path.
- Verification: focused discover/probe tests, full backend regression, diff/scope checks, then specification and quality reviews.
- Stop: do not enter Task 5 until Task 4 reviews, fresh coordinator verification, durable records, and scoped commit pass.

## DriftCheckDraft

Tasks 1–4 match the intent lock, scope fence, baseline lock, canonical-owner rules, compatibility and retirement boundaries, test obligations, and review gates. Task 4 returns exactly the paginated results envelope and a separate facets contract; selected import is transactionally authoritative and route-start fetches requested IDs only. One scan-scoped bounded writer owns persistence, performs count/time batching and final drain, commits before auto-route enqueue, surfaces startup/runtime/final-drain failures, and handles stop-during-start without a second lifecycle owner. The closed-loop cancellation race was repaired at the canonical runner cancellation helper; unrelated open-loop `RuntimeError` remains visible. Old full-list and singular-upsert paths are retired. No frontend, destructive live-state operation, fallback, adapter, or duplicate persistence owner appeared. Residual risks remain accepted offset-page movement during active scans and SQLite single-writer serialization. Decision: continue.
