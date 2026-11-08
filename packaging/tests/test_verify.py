"""验证入口的预检：构建输出目录会让程序以 Low 完整性级别运行时，必须在跑测试前指出来。"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from verify import QUALITY, commands, integrity_problems, preflight, runs_e2e  # noqa: E402

VERIFY = Path(__file__).resolve().parents[1] / "verify.py"


class E2eOnlyOnIntegrationBranchesTest(unittest.TestCase):
    def test_integration_branches_run_e2e(self):
        for branch in ("main", "integration/open-tickets"):
            self.assertTrue(runs_e2e(branch, []), branch)

    def test_other_branches_detached_head_and_unknown_skip_e2e(self):
        for branch in ("impl/79-default-model", "spec/54-big-board-pack", "ticket/62", "research/x", "integration", "mainline", "HEAD", ""):
            self.assertFalse(runs_e2e(branch, []), branch)

    def test_e2e_flag_forces_e2e_on_any_branch(self):
        self.assertTrue(runs_e2e("impl/79-default-model", ["--e2e"]))


class QualityGateTest(unittest.TestCase):
    def test_the_gate_runs_without_mutation_by_default(self):
        self.assertIn(QUALITY, commands([]))
        self.assertNotIn([*QUALITY, "--mutate"], commands([]))

    def test_quality_flag_adds_mutation_to_the_gate(self):
        self.assertIn([*QUALITY, "--mutate"], commands(["--quality"]))
        self.assertNotIn(QUALITY, commands(["--quality"]))


class PreflightOnlyTest(unittest.TestCase):
    def test_preflight_flag_checks_without_running_the_suite(self):
        run = subprocess.run([sys.executable, str(VERIFY), "--preflight"], capture_output=True, text=True, errors="replace", timeout=60)
        self.assertIn(run.returncode, (0, 2), run.stderr)
        self.assertNotIn("===", run.stdout)


@unittest.skipUnless(os.name == "nt", "完整性标签只在 Windows 上存在")
class IntegrityPreflightTest(unittest.TestCase):
    def test_build_outputs_under_a_low_labelled_root_are_reported_even_before_they_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server").mkdir()
            subprocess.run(["icacls", str(root), "/setintegritylevel", "(OI)(CI)L"], check=True, capture_output=True)
            self.assertEqual(integrity_problems(root), [root / "server" / "target", root / "release", root / "client" / "target", root / ".uml-viewer"])
            self.assertEqual(preflight(root), 2)

    def test_medium_build_outputs_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server" / "target").mkdir(parents=True)
            self.assertEqual(integrity_problems(root), [])
            self.assertEqual(preflight(root), 0)


if __name__ == "__main__":
    unittest.main()
