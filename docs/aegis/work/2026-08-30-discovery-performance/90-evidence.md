# Evidence Bundle Draft

- Baseline backend: `.venv/bin/python -m unittest discover -s tests -q` => 138 passed.
- Targeted baseline: discover/probe tests => 58 passed.
- Repository baseline: clean `main` at `ce52f02`.
- Task 1 focused verification: `.venv/bin/python -m unittest tests.test_database tests.test_core -q` => 63 passed.
- Task 1 full regression: `.venv/bin/python -m unittest discover -s tests -q` => 146 passed; only known pre-existing probe socket/file `ResourceWarning`s.
- Task 1 structure: `git diff --check` clean; WAL assignment and `SCHEMA` execution have one canonical owner in `initialize_database`; no `check_same_thread` override.
- Task 1 review: specification approved after configuration-failure cleanup/retry remediation; quality approved with no Critical/Important findings.
- Task 2 focused verification: `.venv/bin/python -m unittest tests.test_discover -q` => 21 passed.
- Task 2 affected integration verification: `.venv/bin/python -m unittest tests.test_probe -q` => 52 passed; only known pre-existing socket/file `ResourceWarning`s.
- Task 2 full regression: `.venv/bin/python -m unittest discover -s tests -q` => 161 passed; two existing `FRPC_MULTI_ROLE=all` deprecation warnings and known `ResourceWarning`s only.
- Task 2 structure: ten-million exact effective target cap; interval-sized lazy plan; queue maxsize equals concurrency; exactly one producer plus concurrency workers; `recentHits` bounded to 100; eager target expansion, per-target scheduling, unbounded `found`, and `found_ips()` retired without aliases.
- Task 2 lifecycle evidence: deterministic cancellation accounting; callback `RuntimeError`, `ValueError`, `SystemExit`, `KeyboardInterrupt`, and `asyncio.CancelledError` surface in state; normal stop remains error-free; scanner-thread reset is rejected before mutation; external reset joins through blocked event-loop final cleanup before a new start is admitted.
- Task 2 review: specification approved; quality approved with no Critical, Important, or Minor findings after final-cleanup publication-order remediation. Independent stress evidence covered callback reset and blocked final cleanup.
- Task 2 repository checks: authorized three-file implementation/test scope before records; `git diff --check` clean.
- Final cross-layer evidence remains pending Tasks 3–6.
