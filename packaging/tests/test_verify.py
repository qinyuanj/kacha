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
    documentation_problems,
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


class DocumentationGateTest(unittest.TestCase):
    """#211：文档与唯一版本源必须一起变更。"""

    @staticmethod
    def make_tree(root: Path, *, version: str = "2.0.0", changelog_version: str | None = None,
                  feedback_note: bool = True, adr: bool = True, glossary: bool = True,
                  token_docs: bool = True, legacy_server_token: bool = False,
                  changelog_token: bool = True) -> None:
        (root / "mygo.config.ts").write_text(
            f'export default {{\n  version: "{version}",\n}};\n', encoding="utf-8")
        heading = changelog_version or version
        item = "- 用户可从首屏提交反馈并附带脱敏诊断包。" if feedback_note else "- 修复了本地画板保存问题。"
        if changelog_token:
            item += " 本次提交使用用户自带的 Gitea token。"
        (root / "docs" / "release").mkdir(parents=True, exist_ok=True)
        (root / "docs" / "release" / "changelog.md").write_text(
            f"<!-- 当前版本在最前 -->\n\n# {heading}\n\n## 新增\n\n{item}\n", encoding="utf-8")
        (root / "docs" / "adr").mkdir(parents=True, exist_ok=True)
        if adr:
            adr_text = (
                "# 0027\n反馈是可选联网能力，核心画板离线可用，不新增远端应用服务依赖；反馈中继只转发用户主动提交的内容。\n"
            )
            if token_docs:
                adr_text += "提交反馈时由用户自带 Gitea token，权限限于 kacha-feedback 仓库的建 issue、评论/标签与附件；中继只在本次请求里转交，不保存、不缓存、不复用，核心画板仍离线可用。\n"
            (root / "docs" / "adr" / "0027-feedback-is-optional.md").write_text(adr_text, encoding="utf-8")
        glossary_text = (
            "# Kacha\n\n**反馈**：用户主动提交的内容。\n_Avoid_：工单、报障\n\n"
            "**反馈中继**：转发反馈的可选服务。\n_Avoid_：反馈服务器、客服系统\n"
        )
        if token_docs:
            glossary_text += (
                "\n**用户自带 token**：用户本人的 Gitea 写凭据，权限限于 kacha-feedback 仓库的建 issue、"
                "写评论/标签与上传附件；中继不保存、不缓存、不复用它，服务端不持有统一写 token。\n"
                "_Avoid_：服务端 token、统一写凭据\n"
            )
        if not glossary:
            glossary_text = "# Kacha\n"
        (root / "GLOSSARY.md").write_text(glossary_text, encoding="utf-8")
        readme_text = "# Kacha\n\n## 反馈\n\n首屏反馈入口可附带脱敏诊断包。\n"
        if token_docs:
            readme_text += (
                "提交反馈时使用用户自带的 Gitea token，需要它对 kacha-feedback 仓库有建 issue、"
                "写评论/标签与上传附件的权限；中继只在这一次请求里转交，服务端不持有统一写 token，核心画板离线可用。\n"
            )
        if legacy_server_token:
            readme_text += "服务端必须配置统一写 token 才能接收反馈。\n"
        (root / "README.md").write_text(readme_text, encoding="utf-8")

    def test_current_docs_pass_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            self.assertEqual(documentation_problems(root), [])

    def test_version_drift_from_the_single_declaration_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, changelog_version="2.0.1")
            problems = documentation_problems(root)
            self.assertTrue(any("2.0.0" in problem and "2.0.1" in problem for problem in problems), problems)

    def test_changelog_without_user_visible_feedback_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, feedback_note=False)
            self.assertTrue(any("反馈" in problem for problem in documentation_problems(root)))

    def test_missing_user_owned_token_statements_are_reported(self):
        """#214：文档必须说清 token 由用户自带、服务端不持有、权限范围与核心仍离线。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, token_docs=False)
            problems = documentation_problems(root)
            self.assertTrue(any("GLOSSARY.md" in problem for problem in problems), problems)
            self.assertTrue(any("README.md" in problem for problem in problems), problems)
            self.assertTrue(any("ADR 0027" in problem for problem in problems), problems)

    def test_server_side_token_requirement_is_reported(self):
        """#214：服务端统一写 token 的要求不再成立，出现即失败。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, legacy_server_token=True)
            problems = documentation_problems(root)
            self.assertTrue(any("统一写 token" in problem for problem in problems), problems)

    def test_changelog_without_token_change_is_reported(self):
        """#214：当前版本的更新说明必须写明 token 变更。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, changelog_token=False)
            problems = documentation_problems(root)
            self.assertTrue(any("token" in problem for problem in problems), problems)

    def test_missing_adr_and_glossary_terms_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, adr=False, glossary=False)
            problems = documentation_problems(root)
            self.assertTrue(any("ADR 0027" in problem for problem in problems), problems)
            self.assertTrue(any("GLOSSARY.md" in problem for problem in problems), problems)

    def test_documentation_gate_stops_the_suite_before_any_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root, changelog_version="9.9.9")
            with (
                mock.patch.object(verify, "ROOT", root),
                mock.patch.object(verify, "integrity_problems", return_value=[]),
                mock.patch.object(verify, "dependencies_preflight", return_value=0),
                mock.patch("subprocess.run", side_effect=AssertionError("不应继续跑命令")),
                mock.patch("sys.stderr", new_callable=mock.MagicMock) as stderr,
                mock.patch("sys.stdout", new_callable=mock.MagicMock),
            ):
                self.assertEqual(main([]), 2)
            self.assertIn("文档与版本门禁失败", "".join(str(call.args[0]) for call in stderr.write.call_args_list))


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
