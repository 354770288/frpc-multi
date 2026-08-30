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
