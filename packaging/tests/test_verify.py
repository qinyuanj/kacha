"""桌面验证入口：验证清单、参数转发与 Windows 完整性预检。"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify import QUALITY, commands, integrity_problems, preflight

VERIFY = Path(__file__).resolve().parents[1] / "verify.py"


class VerificationCommandsTest(unittest.TestCase):
    def test_desktop_suite_runs_go_and_debug_build_without_web_tools(self):
        selected = commands([])
        self.assertIn(["go", "test", "./..."], selected)
        self.assertIn([sys.executable, "packaging/build_desktop.py", "--debug", "--skip-install"], selected)
        self.assertIn(["npm", "--prefix", "client", "test"], selected)
        self.assertIn(["npm", "--prefix", "client", "run", "typecheck"], selected)
        self.assertIn(["npm", "--prefix", "client", "run", "lint:dead"], selected)
        self.assertFalse(any("cargo" in command or "test:e2e" in command for command in selected))

    def test_the_gate_runs_without_mutation_by_default(self):
        self.assertIn(QUALITY, commands([]))
        self.assertNotIn([*QUALITY, "--mutate"], commands([]))

    def test_quality_flag_adds_mutation_to_the_gate(self):
        self.assertIn([*QUALITY, "--mutate"], commands(["--quality"]))
        self.assertNotIn(QUALITY, commands(["--quality"]))

    def test_an_explicit_base_is_forwarded_to_the_gate(self):
        selected = commands(["--quality", "--base", "origin/pr-base"])
        self.assertIn([*QUALITY, "--mutate", "--base", "origin/pr-base"], selected)

    def test_retired_e2e_flag_is_rejected(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit) as caught:
            commands(["--e2e"])
        self.assertEqual(caught.exception.code, 2)

    def test_preflight_flag_checks_without_running_the_suite(self):
        run = subprocess.run([sys.executable, str(VERIFY), "--preflight"], capture_output=True, text=True, errors="replace", timeout=60)
        self.assertIn(run.returncode, (0, 2), run.stderr)
        self.assertNotIn("===", run.stdout)


@unittest.skipUnless(os.name == "nt", "完整性标签只在 Windows 上存在")
class IntegrityPreflightTest(unittest.TestCase):
    def test_low_labelled_root_reports_desktop_outputs_without_creating_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["icacls", str(root), "/setintegritylevel", "(OI)(CI)L"], check=True, capture_output=True)
            self.assertEqual(integrity_problems(root), [root / "build", root / "client" / "target"])
            self.assertEqual(preflight(root), 2)
            self.assertFalse((root / "build").exists())
            self.assertFalse((root / "client").exists())

    def test_medium_build_outputs_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "build").mkdir()
            self.assertEqual(integrity_problems(root), [])
            self.assertEqual(preflight(root), 0)


if __name__ == "__main__":
    unittest.main()
