# Discovery Performance Work Intent

## TaskIntentDraft

Implement the approved bounded discovery architecture: ten-million effective IPv4 input, server pagination, SQLite lifecycle/write improvements, coordinated frontend migration, regression evidence, independent review, and handoff update.

Non-goals: IPv6, distributed scans, resumable tasks, FTS, all-matching selection, production load tests, deployment.

Stop states: done with complete evidence; needs-verification; scope-exceeded; or concrete external blocker.

## BaselineReadSetHint

Required: performance handoff, project memo, current scanner/store/router/database/frontend/types/API/tests.

## BaselineUsageDraft

Required and acknowledged: `chat/PERF_OPT_HANDOFF_2026-08-29.md`, current source/tests, approved session design. Missing: none that changes approach. Decision: continue.

## ImpactStatementDraft

Affected layers: SQLite initialization/schema/indexes; discovery parser/scheduler/status/writer; result/facet/batch/import API; frontend fetching, polling, paging, filtering, sorting, selection and rendering. Compatibility: preserve data and unrelated APIs; retire unbounded result/status and all-coroutine paths in the coordinated migration.
