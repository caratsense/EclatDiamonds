import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import gati_runtime


class GatiRuntimeSafetyTests(unittest.TestCase):
    def test_atomic_json_failure_preserves_previous_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text('{"old":true}\n', encoding="utf-8")

            with patch.object(
                gati_runtime.os, "replace", side_effect=OSError("power loss")
            ), self.assertRaisesRegex(OSError, "power loss"):
                gati_runtime.atomic_write_json(path, {"new": True})

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"old": True})
            self.assertEqual(list(path.parent.glob(".state.json.*.tmp")), [])

    def test_install_lock_rejects_overlap_and_is_released_after_exception(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            gati_runtime, "RUN_LOCK", Path(directory) / "agent.lock"
        ):
            with gati_runtime.install_run_lock("first"):
                with self.assertRaises(gati_runtime.GatiRunAlreadyActive):
                    with gati_runtime.install_run_lock("second"):
                        self.fail("overlapping command acquired the shared lock")

            with self.assertRaisesRegex(RuntimeError, "test failure"):
                with gati_runtime.install_run_lock("third"):
                    raise RuntimeError("test failure")

            with gati_runtime.install_run_lock("fourth"):
                pass


if __name__ == "__main__":
    unittest.main()
