"""Tests for lazy IPv4 discovery planning and bounded scanning."""

import asyncio
import os
import socket
import tempfile
import threading
from itertools import islice
import time
import unittest
from dataclasses import FrozenInstanceError
from unittest.mock import patch

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="frpc-multi-discover-tests-"))

from app.probe.discover import (  # noqa: E402
    MAX_TARGET_IPS,
    RECENT_HITS_LIMIT,
    DiscoverParams,
    DiscoverRunner,
    IPv4Interval,
    TargetPlan,
    parse_target_item,
    parse_targets,
)


def wait_finished(state, timeout=5):
    deadline = time.monotonic() + timeout
    while state.running and time.monotonic() < deadline:
        time.sleep(0.01)
    return not state.running


class ParseTests(unittest.TestCase):
    def test_exact_cidr_semantics(self):
        self.assertEqual(list(islice(parse_target_item("0.0.0.0/0"), 2)), ["0.0.0.1", "0.0.0.2"])
        self.assertEqual(parse_target_item("0.0.0.0/0").size, (1 << 32) - 2)
        self.assertEqual(list(parse_target_item("192.168.1.0/30")),
                         ["192.168.1.1", "192.168.1.2"])
        self.assertEqual(list(parse_target_item("10.0.0.0/31")), ["10.0.0.0"])
        self.assertEqual(list(parse_target_item("10.0.0.7/32")), ["10.0.0.7"])

    def test_ranges_and_ipv4_only(self):
        self.assertEqual(list(parse_target_item("10.0.0.1-10.0.0.3")),
                         ["10.0.0.1", "10.0.0.2", "10.0.0.3"])
        self.assertEqual(list(parse_target_item("10.0.0.253-254")),
                         ["10.0.0.253", "10.0.0.254"])
        for invalid in ("10.0.0.10-10.0.0.1", "10.0.0.1-x", "::1", "2001:db8::/64"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                parse_target_item(invalid)

    def test_overlap_merge_and_exclusion_count(self):
        plan = parse_targets(
            "10.0.0.1-10.0.0.10,10.0.0.5-10.0.0.15,10.0.0.15",
            "10.0.0.3-10.0.0.5,10.0.0.12",
        )
        self.assertIsInstance(plan, TargetPlan)
        self.assertEqual(plan.total, 11)
        self.assertEqual(list(plan), [
            "10.0.0.1", "10.0.0.2", "10.0.0.6", "10.0.0.7", "10.0.0.8",
            "10.0.0.9", "10.0.0.10", "10.0.0.11", "10.0.0.13", "10.0.0.14",
            "10.0.0.15",
        ])

    def test_cap_applies_to_effective_unique_targets(self):
        exact = parse_targets("0.0.0.1-0.152.150.128")
        self.assertEqual(exact.total, MAX_TARGET_IPS)
        with self.assertRaisesRegex(ValueError, str(MAX_TARGET_IPS)):
            parse_targets("0.0.0.1-0.152.150.129")
        # A huge source is valid when exclusions reduce the effective unique plan.
        reduced = parse_targets("0.0.0.0/0", "0.0.0.0-255.103.105.126")
        self.assertEqual(reduced.total, MAX_TARGET_IPS)

    def test_plan_is_frozen_and_lazy(self):
        plan = parse_targets("10.0.0.0/8", "10.0.0.1-10.103.105.126")
        self.assertEqual(plan.total, MAX_TARGET_IPS)
        self.assertIsInstance(plan.intervals[0], IPv4Interval)
        iterator = iter(plan)
        self.assertEqual(next(iterator), "10.103.105.127")
        with self.assertRaises(FrozenInstanceError):
            plan.total = 1
        with self.assertRaises(FrozenInstanceError):
            plan.intervals[0].start = 0

    def test_empty_target_rejected(self):
        with self.assertRaises(ValueError):
            parse_targets("")


class FakeWriter:
    def close(self):
        pass

    async def wait_closed(self):
        pass


class EngineTests(unittest.TestCase):
    def test_scan_finds_open_port_and_status_shape(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(8)
        try:
            runner = DiscoverRunner()
            state = runner.start(DiscoverParams(["127.0.0.1"], [], server.getsockname()[1], 4, 1.0))
            self.assertTrue(wait_finished(state))
            status = runner.status()
            self.assertEqual(status["foundCount"], 1)
            self.assertEqual([hit["ip"] for hit in status["recentHits"]], ["127.0.0.1"])
            self.assertNotIn("found", status)
            self.assertFalse(hasattr(runner, "found_ips"))
        finally:
            server.close()

    def test_recent_hits_are_bounded(self):
        async def succeeds(_ip, _port):
            return object(), FakeWriter()

        runner = DiscoverRunner()
        with patch("app.probe.discover.asyncio.open_connection", new=succeeds):
            state = runner.start(DiscoverParams(["10.0.0.1-10.0.0.105"], [], 7000, 7, 0.5))
            self.assertTrue(wait_finished(state))
        status = runner.status()
        self.assertEqual(status["foundCount"], 105)
        self.assertEqual(len(status["recentHits"]), RECENT_HITS_LIMIT)
        self.assertEqual(status["recentHits"][0]["ip"], "10.0.0.6")

    def _assert_callback_failure_surfaces(self, error):
        async def succeeds(_ip, _port):
            return object(), FakeWriter()

        def fail_callback(*_args):
            raise error

        runner = DiscoverRunner()
        with patch("app.probe.discover.asyncio.open_connection", new=succeeds):
            state = runner.start(
                DiscoverParams(["10.0.0.1-10.0.0.20"], [], 7000, 2, 0.5),
                on_hit=fail_callback,
            )
            self.assertTrue(wait_finished(state))
        self.assertFalse(state.running)
        self.assertIsNotNone(state.finished_at)
        self.assertIn(type(error).__name__, state.error)
        self.assertIn(str(error), state.error)
        self.assertLess(state.scanned, state.total)

    def test_callback_runtime_error_terminates_and_surfaces(self):
        self._assert_callback_failure_surfaces(RuntimeError("persist failed"))

    def test_callback_value_error_terminates_and_surfaces(self):
        self._assert_callback_failure_surfaces(ValueError("invalid persisted hit"))

    def test_callback_base_exception_terminates_and_surfaces(self):
        for error in (SystemExit("shutdown requested"), KeyboardInterrupt("interrupted")):
            with self.subTest(error=type(error).__name__):
                self._assert_callback_failure_surfaces(error)

    def test_callback_cancelled_error_terminates_and_surfaces(self):
        self._assert_callback_failure_surfaces(asyncio.CancelledError("callback cancelled"))

    def test_stop_cancels_promptly_and_does_not_count_unattempted(self):
        all_entered = threading.Event()
        entered_count = 0
        entered_lock = threading.Lock()

        async def hangs(_ip, _port):
            nonlocal entered_count
            with entered_lock:
                entered_count += 1
                if entered_count == 3:
                    all_entered.set()
            await asyncio.Event().wait()

        runner = DiscoverRunner()
        with patch("app.probe.discover.asyncio.open_connection", new=hangs):
            state = runner.start(DiscoverParams(["10.0.0.1-10.0.0.100"], [], 7000, 3, 10.0))
            self.assertTrue(all_entered.wait(2))
            started = time.monotonic()
            self.assertTrue(runner.stop())
            self.assertTrue(wait_finished(state, 2))
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(state.scanned, 3)
        self.assertLess(state.scanned, state.total)
        self.assertEqual(state.error, "")

    def test_callback_reset_is_rejected_without_clearing_lifecycle(self):
        async def succeeds(_ip, _port):
            return object(), FakeWriter()

        runner = DiscoverRunner()

        def reset_from_callback(*_args):
            runner.reset()

        with patch("app.probe.discover.asyncio.open_connection", new=succeeds):
            state = runner.start(
                DiscoverParams(["10.0.0.1-10.0.0.20"], [], 7000, 1, 0.5),
                on_hit=reset_from_callback,
            )
            self.assertTrue(wait_finished(state))

        self.assertFalse(state.running)
        self.assertIsNotNone(state.finished_at)
        self.assertIn("RuntimeError", state.error)
        self.assertIn("不能从扫描线程重置扫描器", state.error)
        self.assertEqual(runner.status()["params"]["targets"], ["10.0.0.1-10.0.0.20"])
        self.assertFalse(runner._resetting)

        runner.reset()
        self.assertEqual(runner.status()["total"], 0)

        async def fails(_ip, _port):
            raise OSError

        with patch("app.probe.discover.asyncio.open_connection", new=fails):
            next_state = runner.start(DiscoverParams(["127.0.0.2"], [], 7000))
            self.assertTrue(wait_finished(next_state))
        self.assertEqual(runner.status()["params"]["targets"], ["127.0.0.2"])

    def test_reset_waits_for_scan_thread_cleanup(self):
        entered = threading.Event()
        cancelled = threading.Event()

        async def hangs(_ip, _port):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        runner = DiscoverRunner()
        with patch("app.probe.discover.asyncio.open_connection", new=hangs):
            state = runner.start(DiscoverParams(["10.0.0.1-10.0.0.20"], [], 7000, 2, 10.0))
            self.assertTrue(entered.wait(2))
            runner.reset()
        self.assertTrue(cancelled.is_set())
        self.assertFalse(state.running)
        self.assertIsNotNone(state.finished_at)
        self.assertEqual(runner.status()["total"], 0)
        self.assertFalse(any(thread.name == "probe-discover" for thread in threading.enumerate()))

    def test_fixed_queue_and_task_structure(self):
        observed = {}
        real_queue = asyncio.Queue
        real_create_task = asyncio.create_task

        def queue_factory(*args, **kwargs):
            observed["maxsize"] = kwargs.get("maxsize", args[0] if args else 0)
            return real_queue(*args, **kwargs)

        def create_task(coro, *args, **kwargs):
            observed["tasks"] = observed.get("tasks", 0) + 1
            return real_create_task(coro, *args, **kwargs)

        async def fails(_ip, _port):
            raise OSError

        runner = DiscoverRunner()
        with patch("app.probe.discover.asyncio.Queue", side_effect=queue_factory), \
             patch("app.probe.discover.asyncio.create_task", side_effect=create_task), \
             patch("app.probe.discover.asyncio.open_connection", new=fails):
            state = runner.start(DiscoverParams(["10.0.0.1-10.0.3.232"], [], 7000, 5, 0.5))
            self.assertTrue(wait_finished(state))
        self.assertEqual(observed, {"maxsize": 5, "tasks": 6})
        self.assertEqual(state.scanned, 1000)


class PersistenceWriterTests(unittest.TestCase):
    def test_successful_start_returns_bounded_and_writer_lives_until_finish(self):
        from app.probe.persistence import _HitWriter

        factory_entered = threading.Event()
        release_factory = threading.Event()
        returned = threading.Event()
        start_errors = []

        class Store:
            def upsert_discover_results_batch(self, _hits):
                return []

        def store_factory():
            factory_entered.set()
            release_factory.wait(2)
            return Store()

        writer = _HitWriter(
            store_factory, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: True,
        )

        def start_writer():
            try:
                writer.start()
            except BaseException as exc:
                start_errors.append(exc)
            finally:
                returned.set()

        starter = threading.Thread(target=start_writer, daemon=True)
        starter.start()
        entered_in_time = factory_entered.wait(0.5)
        release_factory.set()
        returned_in_time = returned.wait(0.5)
        alive_before_finish = writer._thread.is_alive()
        finish_errors = []
        try:
            # If readiness signaling regresses, release the helper before cleanup.
            writer._initialized.set()
            starter.join(2)
            if writer._thread.ident is not None:
                try:
                    writer.finish()
                except BaseException as exc:
                    finish_errors.append(exc)
        finally:
            release_factory.set()
            writer._initialized.set()
            starter.join(2)
            if writer._thread.is_alive():
                try:
                    writer.finish()
                except BaseException as exc:
                    finish_errors.append(exc)

        self.assertTrue(entered_in_time)
        self.assertTrue(returned_in_time)
        self.assertFalse(starter.is_alive())
        self.assertEqual(start_errors, [])
        self.assertTrue(alive_before_finish)
        self.assertEqual(finish_errors, [])
        self.assertFalse(writer._thread.is_alive())

    def test_failed_start_returns_bounded_with_persistence_error_and_joins_writer(self):
        from app.probe.persistence import DiscoverPersistenceError, _HitWriter

        factory_entered = threading.Event()
        release_factory = threading.Event()
        returned = threading.Event()
        start_errors = []

        def store_factory():
            factory_entered.set()
            release_factory.wait(2)
            raise RuntimeError("database unavailable")

        writer = _HitWriter(
            store_factory, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: True,
        )

        def start_writer():
            try:
                writer.start()
            except BaseException as exc:
                start_errors.append(exc)
            finally:
                returned.set()

        starter = threading.Thread(target=start_writer, daemon=True)
        try:
            starter.start()
            entered_in_time = factory_entered.wait(0.5)
            release_factory.set()
            returned_in_time = returned.wait(0.5)

            # Record bounded behavior before forcing readiness for cleanup. This
            # prevents a signaling regression from hanging the test process.
            writer_joined = not writer._thread.is_alive()
        finally:
            release_factory.set()
            writer._initialized.set()
            starter.join(2)
            if writer._thread.is_alive():
                writer._thread.join(2)

        self.assertTrue(entered_in_time)
        self.assertTrue(returned_in_time)
        self.assertFalse(starter.is_alive())
        self.assertEqual(len(start_errors), 1)
        self.assertIsInstance(start_errors[0], DiscoverPersistenceError)
        self.assertIn("database unavailable", str(start_errors[0]))
        self.assertTrue(writer_joined)
        self.assertFalse(writer._thread.is_alive())

    def test_final_partial_batch_commits_before_auto_route(self):
        from app.probe.persistence import _HitWriter

        events = []

        class Store:
            def upsert_discover_results_batch(self, hits):
                events.append(("persist", list(hits)))
                return list(dict.fromkeys(hit[0] for hit in hits))

        writer = _HitWriter(
            Store, auto_route=True,
            enqueue_route=lambda ip: events.append(("route", ip)) or True,
            stop_scan=lambda: True,
            batch_size=10, batch_interval=60,
        )
        writer.start()
        writer.enqueue("10.0.0.1", 7000, 1.0)
        writer.enqueue("10.0.0.1", 7001, 2.0)
        writer.finish()

        self.assertEqual(events[0][0], "persist")
        self.assertEqual(events[1:], [("route", "10.0.0.1")])

    def test_writer_failure_is_visible_and_requests_scan_stop(self):
        from app.probe.persistence import DiscoverPersistenceError, _HitWriter

        stopped = threading.Event()

        class Store:
            def upsert_discover_results_batch(self, _hits):
                raise RuntimeError("disk full")

        writer = _HitWriter(
            Store, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: stopped.set() or True,
            batch_size=1,
        )
        writer.start()
        writer.enqueue("10.0.0.1", 7000, 1.0)
        self.assertTrue(stopped.wait(2))
        with self.assertRaisesRegex(DiscoverPersistenceError, "disk full"):
            writer.finish()

    def test_time_batch_flushes_before_finish(self):
        from app.probe.persistence import _HitWriter

        persisted = threading.Event()

        class Store:
            def upsert_discover_results_batch(self, hits):
                self.hits = list(hits)
                persisted.set()
                return []

        store = Store()
        writer = _HitWriter(
            lambda: store, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: True, batch_size=10, batch_interval=0.02,
        )
        writer.start()
        writer.enqueue("10.0.0.1", 7000, 1.0)
        self.assertTrue(persisted.wait(2))
        writer.finish()
        self.assertEqual(store.hits, [("10.0.0.1", 7000, 1.0)])

    def test_full_queue_applies_callback_backpressure(self):
        from app.probe.persistence import _HitWriter

        persist_entered = threading.Event()
        release_persist = threading.Event()
        third_enqueued = threading.Event()

        class Store:
            def upsert_discover_results_batch(self, _hits):
                persist_entered.set()
                self.assert_released = release_persist.wait(2)
                return []

        store = Store()
        writer = _HitWriter(
            lambda: store, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: True, queue_size=1, batch_size=1, batch_interval=60,
        )
        writer.start()
        writer.enqueue("10.0.0.1", 7000, 1.0)
        self.assertTrue(persist_entered.wait(2))
        writer.enqueue("10.0.0.2", 7000, 2.0)
        blocked = threading.Thread(
            target=lambda: (writer.enqueue("10.0.0.3", 7000, 3.0), third_enqueued.set())
        )
        blocked.start()
        self.assertFalse(third_enqueued.wait(0.05))
        release_persist.set()
        blocked.join(2)
        self.assertFalse(blocked.is_alive())
        writer.finish()
        self.assertTrue(store.assert_released)

    def test_saturated_enqueue_unblocks_when_writer_fails(self):
        from app.probe.persistence import DiscoverPersistenceError, _HitWriter

        persist_entered = threading.Event()
        release_failure = threading.Event()
        enqueue_returned = threading.Event()
        enqueue_errors = []

        class Store:
            def upsert_discover_results_batch(self, _hits):
                persist_entered.set()
                release_failure.wait(2)
                raise RuntimeError("disk full")

        writer = _HitWriter(
            Store, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: True, queue_size=1, batch_size=1, batch_interval=60,
        )
        writer.start()
        writer.enqueue("10.0.0.1", 7000, 1.0)
        self.assertTrue(persist_entered.wait(2))
        writer.enqueue("10.0.0.2", 7000, 2.0)

        def enqueue_blocked_hit():
            try:
                writer.enqueue("10.0.0.3", 7000, 3.0)
            except BaseException as exc:
                enqueue_errors.append(exc)
            finally:
                enqueue_returned.set()

        blocked = threading.Thread(target=enqueue_blocked_hit)
        blocked.start()
        self.assertFalse(enqueue_returned.wait(0.05))
        release_failure.set()
        self.assertTrue(enqueue_returned.wait(2))
        blocked.join(2)
        self.assertFalse(blocked.is_alive())
        self.assertEqual(len(enqueue_errors), 1)
        self.assertIsInstance(enqueue_errors[0], DiscoverPersistenceError)
        self.assertIn("disk full", str(enqueue_errors[0]))
        with self.assertRaisesRegex(DiscoverPersistenceError, "disk full"):
            writer.finish()

    def test_hit_queue_is_bounded(self):
        from app.probe.persistence import _HitWriter

        writer = _HitWriter(
            lambda: object(), auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=lambda: True, queue_size=3,
        )
        self.assertEqual(writer._queue.maxsize, 3)

    def test_failure_is_joined_before_finish_returns(self):
        from app.probe.persistence import DiscoverPersistenceError, _HitWriter

        stop_entered = threading.Event()
        release_stop = threading.Event()
        finish_returned = threading.Event()
        finish_error = []

        class Store:
            def upsert_discover_results_batch(self, _hits):
                raise RuntimeError("disk full")

        def slow_stop():
            stop_entered.set()
            release_stop.wait(2)
            return True

        writer = _HitWriter(
            Store, auto_route=False, enqueue_route=lambda _ip: True,
            stop_scan=slow_stop, batch_size=1,
        )
        writer.start()
        writer.enqueue("10.0.0.1", 7000, 1.0)
        self.assertTrue(stop_entered.wait(2))

        def finish():
            try:
                writer.finish()
            except BaseException as exc:
                finish_error.append(exc)
            finally:
                finish_returned.set()

        finisher = threading.Thread(target=finish)
        finisher.start()
        self.assertFalse(finish_returned.wait(0.05))
        release_stop.set()
        self.assertTrue(finish_returned.wait(2))
        finisher.join()
        self.assertEqual(len(finish_error), 1)
        self.assertIsInstance(finish_error[0], DiscoverPersistenceError)
        self.assertFalse(writer._thread.is_alive())


class CoordinatorLifecycleTests(unittest.TestCase):
    def test_stop_during_start_is_accepted_and_not_lost(self):
        from app.probe.persistence import DiscoverScanCoordinator

        start_entered = threading.Event()
        release_start = threading.Event()
        start_result = []
        start_error = []

        class BlockingStartRunner(DiscoverRunner):
            def start(self, params, on_hit=None):
                start_entered.set()
                release_start.wait(2)
                return super().start(params, on_hit=on_hit)

        class Store:
            def upsert_discover_results_batch(self, _hits):
                return []

        runner = BlockingStartRunner()
        coordinator = DiscoverScanCoordinator(runner, Store, lambda _ip: True)

        def start_scan():
            try:
                start_result.append(coordinator.start(
                    DiscoverParams(["10.0.0.1-10.0.0.254"], [], 7000, 1, 10.0),
                    auto_route=False,
                ))
            except BaseException as exc:
                start_error.append(exc)

        starter = threading.Thread(target=start_scan)
        starter.start()
        self.assertTrue(start_entered.wait(2))
        self.assertTrue(coordinator.stop())
        release_start.set()
        starter.join(2)
        self.assertFalse(starter.is_alive())
        self.assertEqual(start_error, [])
        self.assertEqual(len(start_result), 1)
        self.assertTrue(wait_finished(start_result[0], 2))
        self.assertFalse(coordinator.status()["running"])
        self.assertIsNone(coordinator._writer)

    def test_store_startup_failure_is_bounded_joined_and_immediately_retryable(self):
        from app.probe.persistence import DiscoverPersistenceError, DiscoverScanCoordinator

        factory_entered = threading.Event()
        release_factory = threading.Event()
        returned = threading.Event()
        retry_returned = threading.Event()
        start_errors = []
        retry_errors = []
        retry_states = []
        writers = []
        fail = True

        class TrackingRunner(DiscoverRunner):
            def __init__(self):
                super().__init__()
                self.start_calls = 0

            def start(self, params, on_hit=None):
                self.start_calls += 1
                return super().start(params, on_hit=on_hit)

        runner = TrackingRunner()
        coordinator = None

        def store_factory():
            writers.append(coordinator._writer)
            factory_entered.set()
            release_factory.wait(2)
            if fail:
                raise RuntimeError("database unavailable")
            return type("Store", (), {"upsert_discover_results_batch": lambda self, hits: []})()

        coordinator = DiscoverScanCoordinator(runner, store_factory, lambda _ip: True)

        def start_scan():
            try:
                coordinator.start(
                    DiscoverParams(["10.0.0.1-10.0.0.254"], [], 7000), auto_route=False,
                )
            except BaseException as exc:
                start_errors.append(exc)
            finally:
                returned.set()

        starter = threading.Thread(target=start_scan, daemon=True)
        starter.start()
        entered_in_time = factory_entered.wait(0.5)
        release_factory.set()
        returned_in_time = returned.wait(0.5)

        # Preserve the bounded assertion, then force readiness only for cleanup
        # so a signaling regression cannot strand the helper or reservation.
        failed_writer = writers[0] if writers else None
        if failed_writer is not None:
            failed_writer._initialized.set()
        starter.join(2)
        failed_writer_joined = failed_writer is not None and not failed_writer._thread.is_alive()
        status_after_failure = coordinator.status()
        writer_cleared = coordinator._writer is None
        runner_not_started = runner.start_calls == 0

        fail = False
        factory_entered.clear()
        release_factory.clear()

        async def misses(_ip, _port):
            raise OSError

        def retry_scan():
            try:
                retry_states.append(coordinator.start(
                    DiscoverParams(["127.0.0.2"], [], 7000), auto_route=False,
                ))
            except BaseException as exc:
                retry_errors.append(exc)
            finally:
                retry_returned.set()

        retry = threading.Thread(target=retry_scan, daemon=True)
        try:
            with patch("app.probe.discover.asyncio.open_connection", new=misses):
                retry.start()
                retry_entered_in_time = factory_entered.wait(0.5)
                release_factory.set()
                retry_returned_in_time = retry_returned.wait(0.5)
                # If readiness signaling regresses, unblock start for deterministic cleanup.
                if len(writers) > 1 and writers[1] is not None:
                    writers[1]._initialized.set()
                retry.join(2)
                retry_finished = bool(retry_states) and wait_finished(retry_states[0], 2)
        finally:
            release_factory.set()
            if failed_writer is not None:
                failed_writer._initialized.set()
            if len(writers) > 1 and writers[1] is not None:
                writers[1]._initialized.set()
            starter.join(2)
            retry.join(2)
            coordinator.stop()
            if retry_states:
                wait_finished(retry_states[0], 2)

        self.assertTrue(entered_in_time)
        self.assertTrue(returned_in_time)
        self.assertFalse(starter.is_alive())
        self.assertEqual(len(start_errors), 1)
        self.assertIsInstance(start_errors[0], DiscoverPersistenceError)
        self.assertIn("database unavailable", str(start_errors[0]))
        self.assertTrue(failed_writer_joined)
        self.assertTrue(runner_not_started)
        self.assertFalse(status_after_failure["running"])
        self.assertIsNone(status_after_failure["params"])
        self.assertIn("database unavailable", status_after_failure["error"])
        self.assertTrue(writer_cleared)
        self.assertTrue(retry_entered_in_time)
        self.assertTrue(retry_returned_in_time)
        self.assertFalse(retry.is_alive())
        self.assertEqual(retry_errors, [])
        self.assertEqual(len(retry_states), 1)
        self.assertTrue(retry_finished)
        self.assertEqual(retry_states[0].error, "")
        self.assertEqual(runner.start_calls, 1)
        self.assertIsNone(coordinator._writer)

    def test_stop_drains_last_accepted_hit_before_terminal_status(self):
        from app.probe.persistence import DiscoverScanCoordinator

        persisted = threading.Event()
        second_attempt = threading.Event()

        class Store:
            def __init__(self):
                self.hits = []

            def upsert_discover_results_batch(self, hits):
                self.hits.extend(hits)
                persisted.set()
                return []

        store = Store()
        attempts = 0

        async def one_hit_then_hang(_ip, _port):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return object(), FakeWriter()
            second_attempt.set()
            await asyncio.Event().wait()

        runner = DiscoverRunner()
        coordinator = DiscoverScanCoordinator(runner, lambda: store, lambda _ip: True)
        with patch("app.probe.discover.asyncio.open_connection", new=one_hit_then_hang):
            state = coordinator.start(
                DiscoverParams(["10.0.0.1-10.0.0.20"], [], 7000, 1, 10.0), auto_route=False,
            )
            self.assertTrue(second_attempt.wait(2))
            self.assertTrue(coordinator.stop())
            self.assertTrue(wait_finished(state, 2))
        self.assertTrue(persisted.is_set())
        self.assertEqual(len(store.hits), 1)
        self.assertFalse(state.running)
        self.assertIsNone(coordinator._writer)

    def test_persistence_failure_stops_scan_and_surfaces_in_status(self):
        from app.probe.persistence import DiscoverScanCoordinator

        class Store:
            def upsert_discover_results_batch(self, _hits):
                raise RuntimeError("disk full")

        async def succeeds(_ip, _port):
            return object(), FakeWriter()

        runner = DiscoverRunner()
        coordinator = DiscoverScanCoordinator(runner, Store, lambda _ip: True)
        with patch("app.probe.discover.asyncio.open_connection", new=succeeds):
            state = coordinator.start(
                DiscoverParams(["10.0.0.1-10.0.1.44"], [], 7000, 1, 0.5), auto_route=False,
            )
            self.assertTrue(wait_finished(state, 2))
        status = coordinator.status()
        self.assertFalse(status["running"])
        self.assertIn("DiscoverPersistenceError", status["error"])
        self.assertIn("disk full", status["error"])
        self.assertLess(status["scanned"], status["total"])
        self.assertIsNone(coordinator._writer)

    def test_final_partial_batch_failure_after_loop_close_has_no_thread_exception(self):
        from app.probe.persistence import DiscoverScanCoordinator

        uncaught = []
        persisted_after_close = threading.Event()
        previous_hook = threading.excepthook
        test_case = self

        class Store:
            def upsert_discover_results_batch(self, _hits):
                test_case.assertTrue(runner._loop is not None and runner._loop.is_closed())
                persisted_after_close.set()
                raise RuntimeError("final drain disk full")

        async def succeeds(_ip, _port):
            return object(), FakeWriter()

        runner = DiscoverRunner()
        coordinator = DiscoverScanCoordinator(runner, Store, lambda _ip: True)
        threading.excepthook = uncaught.append
        try:
            with patch("app.probe.discover.asyncio.open_connection", new=succeeds):
                state = coordinator.start(
                    DiscoverParams(["10.0.0.1"], [], 7000, 1, 0.5), auto_route=False,
                )
                self.assertTrue(wait_finished(state, 2))
        finally:
            threading.excepthook = previous_hook

        status = coordinator.status()
        self.assertTrue(persisted_after_close.is_set())
        self.assertEqual(uncaught, [])
        self.assertFalse(status["running"])
        self.assertIn("DiscoverPersistenceError", status["error"])
        self.assertIn("final drain disk full", status["error"])
        self.assertIsNone(coordinator._writer)


class RunnerGuardTests(unittest.TestCase):
    def test_params_are_validated(self):
        runner = DiscoverRunner()
        invalid = [
            DiscoverParams(["127.0.0.1"], [], 0),
            DiscoverParams(["127.0.0.1"], [], 65536),
            DiscoverParams(["127.0.0.1"], [], 80, 0),
            DiscoverParams(["127.0.0.1"], [], 80, 2001),
            DiscoverParams(["127.0.0.1"], [], 80, 1, 0.1),
            DiscoverParams(["127.0.0.1"], [], 80, 1, 11),
        ]
        for params in invalid:
            with self.subTest(params=params), self.assertRaises(ValueError):
                runner.start(params)

    def test_reset_waits_through_final_loop_cleanup(self):
        close_entered = threading.Event()
        release_close = threading.Event()
        reset_returned = threading.Event()
        real_loop = asyncio.new_event_loop()
        loop_type = type(real_loop)
        real_close = loop_type.close
        real_loop.close()

        def blocking_close(loop):
            if threading.current_thread().name == "probe-discover":
                close_entered.set()
                release_close.wait(2)
            real_close(loop)

        async def fails(_ip, _port):
            raise OSError

        runner = DiscoverRunner()
        with patch.object(loop_type, "close", new=blocking_close), \
             patch("app.probe.discover.asyncio.open_connection", new=fails):
            state = runner.start(DiscoverParams(["127.0.0.1"], [], 7000))
            self.assertTrue(close_entered.wait(2))
            self.assertTrue(state.running)

            reset_thread = threading.Thread(
                target=lambda: (runner.reset(), reset_returned.set())
            )
            reset_thread.start()

            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                with runner._lock:
                    if runner._resetting:
                        break
                time.sleep(0.005)
            else:
                self.fail("reset did not enter its guarded lifecycle")

            self.assertFalse(reset_returned.wait(0.05))
            with self.assertRaisesRegex(RuntimeError, "正在重置"):
                runner.start(DiscoverParams(["127.0.0.2"], [], 7000))

            release_close.set()
            reset_thread.join(2)
            self.assertFalse(reset_thread.is_alive())
            self.assertTrue(reset_returned.is_set())
            self.assertFalse(state.running)
            self.assertIsNotNone(state.finished_at)
            self.assertEqual(runner.status()["total"], 0)

            next_state = runner.start(DiscoverParams(["127.0.0.2"], [], 7000))
            self.assertTrue(wait_finished(next_state))
        self.assertEqual(runner.status()["params"]["targets"], ["127.0.0.2"])

    def test_reset_excludes_start_until_old_scan_is_joined(self):
        old_scan_entered = threading.Event()
        release_old_scan = threading.Event()
        invocation_lock = threading.Lock()
        invocations = 0

        class ResetRaceRunner(DiscoverRunner):
            def _run(self, state, plan, on_hit):
                nonlocal invocations
                with invocation_lock:
                    invocations += 1
                    invocation = invocations
                if invocation != 1:
                    return super()._run(state, plan, on_hit)
                old_scan_entered.set()
                release_old_scan.wait(2)
                with self._lock:
                    state.running = False
                    state.finished_at = "finished"

        runner = ResetRaceRunner()
        old_state = runner.start(DiscoverParams(["127.0.0.1"], [], 7000))
        self.assertTrue(old_scan_entered.wait(2))
        reset_thread = threading.Thread(target=runner.reset)
        reset_thread.start()

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with runner._lock:
                if runner._resetting:
                    break
            time.sleep(0.005)
        else:
            self.fail("reset did not enter its guarded lifecycle")

        with self.assertRaisesRegex(RuntimeError, "正在重置"):
            runner.start(DiscoverParams(["127.0.0.2"], [], 7000))
        release_old_scan.set()
        reset_thread.join(2)
        self.assertFalse(reset_thread.is_alive())
        self.assertFalse(old_state.running)

        async def fails(_ip, _port):
            raise OSError

        with patch("app.probe.discover.asyncio.open_connection", new=fails):
            new_state = runner.start(DiscoverParams(["127.0.0.2"], [], 7000))
            self.assertTrue(wait_finished(new_state))
        self.assertEqual(runner.status()["params"]["targets"], ["127.0.0.2"])

    def test_status_waits_for_runner_lock_before_snapshot(self):
        runner = DiscoverRunner()
        completed = threading.Event()
        snapshots = []

        runner._lock.acquire()
        try:
            thread = threading.Thread(
                target=lambda: (snapshots.append(runner.status()), completed.set())
            )
            thread.start()
            self.assertFalse(completed.wait(0.05))
        finally:
            runner._lock.release()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(snapshots[0]["total"], 0)

    def test_concurrent_start_has_one_winner(self):
        release = threading.Event()

        class HoldingRunner(DiscoverRunner):
            def _run(self, state, plan, on_hit):
                release.wait(2)
                state.running = False

        runner = HoldingRunner()
        barrier = threading.Barrier(3)
        outcomes = []

        def start():
            barrier.wait()
            try:
                runner.start(DiscoverParams(["127.0.0.1"], [], 7000))
                outcomes.append("started")
            except RuntimeError:
                outcomes.append("rejected")

        threads = [threading.Thread(target=start) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(2)
        release.set()
        self.assertCountEqual(outcomes, ["started", "rejected"])


if __name__ == "__main__":
    unittest.main()
