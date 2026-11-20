"""桌面验证入口：验证清单、参数转发、Windows 完整性预检与前端依赖校验。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify
from verify import (
    INSTALL_HINT,
    INSTALL_RECORD,
    QUALITY,
    ROOT,
    commands,
    dependency_problems,
    dependencies_preflight,
    integrity_problems,
    main,
    preflight,
)

VERIFY = ROOT / "packaging" / "verify.py"

LOCKED = {
    "": {"name": "kacha-client", "devDependencies": {"@playwright/test": "^1.65.1"}},
    "node_modules/@playwright/test": {"version": "1.65.1"},
}
INSTALLED = {"node_modules/@playwright/test": {"version": "1.65.1"}}


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

    def test_quality_flag_keeps_the_gate_free_of_mutation(self):
        """#193：2026-11-20 决定不做变异测试，--quality 只跑 CRAP 与重复检查。"""
        self.assertIn(QUALITY, commands(["--quality"]))
        self.assertFalse([command for command in commands(["--quality"]) if "--mutate" in command])

    def test_no_argument_can_bring_mutation_back_into_the_gate(self):
        """任何参数组合都不许再拼出 --mutate：本机 commit limit 只有 23,060 MB，跑它会整机崩溃。"""
        for argv in ([], ["--quality"], ["--base", "origin/main"], ["--quality", "--base", "origin/main"]):
            self.assertFalse([command for command in commands(argv) if "--mutate" in command], argv)

    def test_an_explicit_base_is_forwarded_to_the_gate(self):
        selected = commands(["--quality", "--base", "origin/pr-base"])
        self.assertIn([*QUALITY, "--base", "origin/pr-base"], selected)

    def test_retired_e2e_flag_is_rejected(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit) as caught:
            commands(["--e2e"])
        self.assertEqual(caught.exception.code, 2)

    def test_preflight_flag_checks_without_running_the_suite(self):
        run = subprocess.run([sys.executable, str(VERIFY), "--preflight"], capture_output=True, text=True, errors="replace", timeout=60)
        self.assertIn(run.returncode, (0, 2), run.stderr)
        self.assertNotIn("===", run.stdout)


def client_tree(root: Path, locked: dict, installed: dict | None, on_disk: tuple[str, ...] = ()) -> Path:
    """造一份 lockfile / 安装记录 / node_modules；installed 为 None 表示没装过依赖。"""
    client = root / "client"
    node_modules = client / "node_modules"
    node_modules.mkdir(parents=True, exist_ok=True)
    (client / "package-lock.json").write_text(json.dumps({"packages": locked}), encoding="utf-8")
    if installed is not None:
        (node_modules / ".package-lock.json").write_text(json.dumps({"packages": installed}), encoding="utf-8")
    for relative in on_disk:
        manifest = client / relative / "package.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text("{}", encoding="utf-8")
    return root


class DependencyPreflightTest(unittest.TestCase):
    def test_install_matching_the_lockfile_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), LOCKED, INSTALLED, ("node_modules/@playwright/test",))
            with mock.patch("subprocess.run", side_effect=AssertionError("检查依赖不应启动进程")):
                self.assertEqual(dependency_problems(root), [])
            self.assertEqual(dependencies_preflight(root), 0)

    def test_lockfile_newer_than_the_install_reports_the_missing_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), LOCKED, {}, ())
            self.assertEqual(dependency_problems(root), ["缺少 @playwright/test"])
            with mock.patch("sys.stderr", new_callable=mock.MagicMock) as stderr:
                self.assertEqual(dependencies_preflight(root), 2)
            report = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
            self.assertIn("缺少 @playwright/test", report)
            self.assertIn("package-lock.json", report)
            self.assertIn(INSTALL_HINT, report)

    def test_drifted_version_reports_both_versions(self):
        outdated = {"node_modules/@playwright/test": {"version": "1.50.0"}}
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), LOCKED, outdated, ("node_modules/@playwright/test",))
            self.assertEqual(dependency_problems(root), ["@playwright/test 是 1.50.0，lockfile 要 1.65.1"])

    def test_platform_optional_packages_need_not_be_installed(self):
        locked = {**LOCKED, "node_modules/@oxc-parser/binding-linux-x64-gnu": {"version": "1.0.0", "optional": True}}
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), locked, INSTALLED, ("node_modules/@playwright/test",))
            self.assertEqual(dependency_problems(root), [])

    def test_missing_install_record_reports_uninstalled_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), LOCKED, None, ())
            self.assertEqual(dependency_problems(root), ["client/node_modules 未按 lockfile 安装"])

    def test_a_truncated_install_record_is_reported_as_damaged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), LOCKED, {}, ("node_modules/@playwright/test",))
            (root / INSTALL_RECORD).write_text("{", encoding="utf-8")
            self.assertEqual(dependency_problems(root), ["client/node_modules/.package-lock.json 无法解析，安装记录已损坏"])

    def test_a_stale_install_stops_the_suite_before_any_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = client_tree(Path(tmp), LOCKED, {}, ())
            with (
                mock.patch.object(verify, "ROOT", root),
                mock.patch.object(verify, "integrity_problems", return_value=[]),
                mock.patch("subprocess.run", side_effect=AssertionError("不应继续跑命令")),
                mock.patch("sys.stderr", new_callable=mock.MagicMock) as stderr,
                mock.patch("sys.stdout", new_callable=mock.MagicMock) as stdout,
            ):
                self.assertEqual(main([]), 2)
            self.assertNotIn("===", "".join(str(call.args[0]) for call in stdout.write.call_args_list))
            self.assertIn("已跳过", "".join(str(call.args[0]) for call in stderr.write.call_args_list))

    @unittest.skipUnless((ROOT / INSTALL_RECORD).is_file(), "本机未安装前端依赖，无法验证真实树")
    def test_a_real_satisfied_install_is_not_a_false_positive(self):
        self.assertEqual(dependency_problems(ROOT), [])


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
