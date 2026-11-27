"""桌面验证入口：验证清单、参数转发、Windows 完整性预检与前端依赖校验。"""

import io
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
    RACE,
    RACE_NOTICE,
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
    def test_desktop_suite_runs_the_whole_ordered_gate(self):
        """README 默认验证的完整顺序：打包单测 → 前端单测 → 类型检查 → knip → go test → go test -race（定向 diagnostics）→ debug 构建 → 质量门禁。

        断言整条有序清单（不是子集）：删、改或挪动任一步都会在这里挂掉，才抓得到门禁漂移。
        """
        self.assertEqual(commands([]), [
            [sys.executable, "-m", "unittest", "discover", "-s", "packaging/tests"],
            ["npm", "--prefix", "client", "test"],
            ["npm", "--prefix", "client", "run", "typecheck"],
            ["npm", "--prefix", "client", "run", "lint:dead"],
            ["go", "test", "./..."],
            list(RACE),
            [sys.executable, "packaging/build_desktop.py", "--debug", "--skip-install"],
            list(QUALITY),
        ])

    def test_no_argument_can_bring_mutation_back_into_the_gate(self):
        """#193：任何参数组合都不许再拼出 --mutate（本机 commit limit 只有 23,060 MB，跑它会整机崩溃）。

        同时覆盖「默认就跑质量门禁」与「--quality 也跑质量门禁」两条契约（原 :47 / :51 已并入此处）。
        """
        self.assertIn(QUALITY, commands([]))
        self.assertIn(QUALITY, commands(["--quality"]))
        for argv in ([], ["--quality"], ["--base", "origin/main"], ["--quality", "--base", "origin/main"]):
            self.assertFalse([command for command in commands(argv) if "--mutate" in command], argv)

    def test_the_concurrency_proof_runs_race_on_diagnostics_only(self):
        """#229 的验收要求用 -race 证明诊断导出与日志记录并发安全。

        整仓跑 -race 太慢且本机内存有限，所以只定向 diagnostics；这条断言同时保证它没被
        删掉、没被放宽成整仓，也没有多出第二个 -race 步骤。
        """
        race = [command for command in commands([]) if "-race" in command]
        self.assertEqual(len(race), 1, race)
        self.assertEqual(race[0], ["go", "test", "-race", "./desktop/internal/diagnostics/..."])
        self.assertNotIn("./...", race[0])

    def test_a_missing_c_toolchain_is_announced_and_does_not_fail_the_gate(self):
        """本机没有 C 工具链时 -race 跑不了：门禁要大声说「未运行」，既不静默跳过也不误报失败。"""
        started: list[list[str]] = []

        def fake_run(command, **kwargs):
            started.append(list(command))
            return subprocess.CompletedProcess(command, 0)

        out = io.StringIO()
        with (
            mock.patch.object(verify, "preflight", return_value=0),
            mock.patch.object(verify, "dependencies_preflight", return_value=0),
            mock.patch.object(verify, "documentation_preflight", return_value=0),
            mock.patch.object(verify, "race_toolchain_available", return_value=False),
            mock.patch.object(verify.shutil, "which", return_value="tool"),
            mock.patch("subprocess.run", side_effect=fake_run),
            mock.patch("sys.stdout", out),
        ):
            self.assertEqual(main([]), 0)
        report = out.getvalue()
        self.assertFalse([command for command in started if "-race" in command], started)
        self.assertIn(RACE_NOTICE, report)
        self.assertIn(f"未运行  {' '.join(RACE)}", report)

    def test_the_race_step_really_runs_when_a_c_toolchain_exists(self):
        """有工具链（例如 CI）时这条不是摆设：真的以 -race 跑 diagnostics 包。"""
        started: list[list[str]] = []

        def fake_run(command, **kwargs):
            started.append(list(command))
            return subprocess.CompletedProcess(command, 0)

        out = io.StringIO()
        with (
            mock.patch.object(verify, "preflight", return_value=0),
            mock.patch.object(verify, "dependencies_preflight", return_value=0),
            mock.patch.object(verify, "documentation_preflight", return_value=0),
            mock.patch.object(verify, "race_toolchain_available", return_value=True),
            mock.patch.object(verify.shutil, "which", return_value="tool"),
            mock.patch("subprocess.run", side_effect=fake_run),
            mock.patch("sys.stdout", out),
        ):
            self.assertEqual(main([]), 0)
        raced = [command for command in started if "-race" in command]
        self.assertEqual(len(raced), 1, raced)
        # main 用 which 解析出的可执行文件替换 argv[0]，其余参数原样。
        self.assertEqual(raced[0][1:], RACE[1:])
        self.assertIn(f"通过  {' '.join(RACE)}", out.getvalue())

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
                "# 0027\n反馈是可选联网能力，核心画板离线可用，不依赖远端应用服务；桌面使用本机授权直连 Gitea。\n"
            )
            if token_docs:
                adr_text += "提交反馈时由用户自带 Gitea token，权限限于 kacha-feedback 仓库的建 issue、评论/标签与附件；桌面直连 Gitea，核心画板仍离线可用。\n"
            (root / "docs" / "adr" / "0027-feedback-is-optional.md").write_text(adr_text, encoding="utf-8")
        glossary_text = "# Kacha\n\n**反馈**：用户主动提交的内容。\n_Avoid_：工单、报障\n\n"
        if token_docs:
            glossary_text += (
                "\n**用户自带 token**：用户本人的 Gitea 写凭据，权限限于 kacha-feedback 仓库的建 issue、"
                "写评论/标签与上传附件；只由桌面本机服务直接用于 Gitea API 鉴权。\n"
                "_Avoid_：服务端 token、统一写凭据\n"
            )
        if not glossary:
            glossary_text = "# Kacha\n"
        (root / "GLOSSARY.md").write_text(glossary_text, encoding="utf-8")
        readme_text = "# Kacha\n\n## 反馈\n\n首屏反馈入口可附带脱敏诊断包。\n"
        if token_docs:
            readme_text += (
                "提交反馈时使用用户自带的 Gitea token，需要它对 kacha-feedback 仓库有建 issue、"
                "写评论/标签与上传附件的权限；桌面直连 Gitea，核心画板离线可用。\n"
            )
        if legacy_server_token:
            readme_text += "服务端必须配置统一写 token 才能接收反馈。\n"
        (root / "README.md").write_text(readme_text, encoding="utf-8")

    def test_current_docs_pass_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            self.assertEqual(documentation_problems(root), [])

    def test_the_real_repository_docs_pass_the_gate(self):
        """真实仓库文档必须过门禁：合成树的用例证明规则，这一条防止真身漂移（不只在 CI 真跑 verify 时才发现）。"""
        self.assertEqual(documentation_problems(ROOT), [])

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
        """#260：文档必须说清 token 由用户自带、桌面直连、权限范围与核心仍离线。"""
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
