"""Serialize DNS writes with mutations that can remove their candidate assets."""

import threading

sync_lock = threading.Lock()
