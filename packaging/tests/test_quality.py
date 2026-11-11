"""质量门禁的判定：改动集只取业务源码，dryer 配对只在碰到改动文件时算违规，范围只有 uml-quality.json 一处；

工具从 dsh-uml-viewer 的单一二进制按子命令调用，mutator 额外复制仓库的 contracts/，未覆盖变异点从包内
`.metrics/mutate/*.edn` 快照统计（见 docs/adr/0022）。
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quality import (MUTATION_COPIES, VIEWER_BINARY_NAME, ViewerMissing, Package, Scope, changed_files,  # noqa: E402
                     copy_supported, crap_unmeasured, dry_offenders, in_scope, mutation_command, mutation_uncovered,
                     packages, tool_command, uncovered_sites, viewer_binary)

BINARY = Path("/opt/uml-viewer")

REPORT = """DUPLICATE score=0.91
  client/src/a.ts:3-13
  client/src/b.ts:3-14
DUPLICATE score=0.85
  server/src/x.rs:10-30
  server/src/y.rs:40-61
"""


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


class ScopeTest(unittest.TestCase):
    def test_scope_comes_from_uml_quality_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "uml-quality.json").write_text(json.dumps({"version": 1, "standardTools": {
                "sourceRoots": ["client/src", "server/src"], "exclude": ["**/*.test.ts"]}}), encoding="utf-8")
            scope = Scope.load(root)
        self.assertEqual(scope, Scope(roots=("client/src", "server/src"), excludes=("**/*.test.ts",)))

    def test_only_typescript_and_rust_sources_under_a_root_are_in_scope(self):
        scope = Scope(roots=("client/src", "server/src"), excludes=())
        self.assertEqual(in_scope(scope, ["client/src/a.ts", "client/src/b.tsx", "server/src/x.rs", "client/e2e/c.ts",
                                          "server/tests/t.rs", "client/src/style.css", "docs/a.md"]),
                         ["client/src/a.ts", "client/src/b.tsx", "server/src/x.rs"])


class PackagesTest(unittest.TestCase):
    """每个源码根的上一级是一个包（client、server），工具以包为根运行，范围与改动都换算成包内路径。"""

    scope = Scope(roots=("client/src", "server/src"), excludes=("client/src/**/*.test.ts", "client/src/core/testing"))

    def test_each_source_root_becomes_a_package_with_its_own_relative_scope(self):
        client, server = packages(self.scope)
        self.assertEqual((client.root, client.tool_args()),
                         ("client", ["--root", "client", "-s", "src", "--exclude", "src/**/*.test.ts", "--exclude", "src/core/testing"]))
        self.assertEqual((server.root, server.tool_args()), ("server", ["--root", "server", "-s", "src"]))

    def test_changed_files_are_split_per_package_and_made_relative(self):
        client, server = packages(self.scope)
        changed = ["client/src/a.ts", "server/src/x.rs", "client/src/ui/b.tsx"]
        self.assertEqual(client.own(changed), ["src/a.ts", "src/ui/b.tsx"])
        self.assertEqual(server.own(changed), ["src/x.rs"])


class ToolCommandTest(unittest.TestCase):
    """三个工具都是同一个 uml-viewer 二进制的子命令，不再各装一个 Python 工具（见 docs/adr/0022）。"""

    scope = Scope(roots=("client/src", "server/src"), excludes=("client/src/**/*.test.ts",))

    def test_crapper_and_dryer_keep_their_scope_arguments_as_subcommands(self):
        client = packages(self.scope)[0]
        self.assertEqual(tool_command(BINARY, "crap", [*client.tool_args(), "--threshold", "10", "src/a.ts"]),
                         [str(BINARY), "crap", "--root", "client", "-s", "src", "--exclude", "src/**/*.test.ts",
                          "--threshold", "10", "src/a.ts"])
        self.assertEqual(tool_command(BINARY, "dry", [*client.tool_args(), "--threshold", "0.8"]),
                         [str(BINARY), "dry", "--root", "client", "-s", "src", "--exclude", "src/**/*.test.ts",
                          "--threshold", "0.8"])


class MutationCommandTest(unittest.TestCase):
    """mutator 的变异副本里要有仓库根的 contracts/，否则包外 JSON 不在副本里，基线测试就失败（见 #102）。"""

    scope = Scope(roots=("client/src", "server/src"), excludes=("client/src/**/*.test.ts",))

    def test_the_mutator_command_copies_the_repository_contracts(self):
        client = packages(self.scope)[0]
        self.assertEqual(mutation_command(BINARY, client, ["src/a.ts"]),
                         [str(BINARY), "mutate", "--root", "client", "-s", "src", "--exclude", "src/**/*.test.ts",
                          "--copy", "../contracts", "src/a.ts"])

    def test_both_packages_are_one_level_below_the_repository_root(self):
        client, server = packages(self.scope)
        self.assertEqual(MUTATION_COPIES, ("../contracts",))
        self.assertEqual(mutation_command(BINARY, client, [])[2:6], ["--root", "client", "-s", "src"])
        self.assertEqual(mutation_command(BINARY, server, [])[2:],
                         ["--root", "server", "-s", "src", "--copy", "../contracts"])

    def test_only_the_mutator_gets_the_copy_flag(self):
        self.assertNotIn("--copy", tool_command(BINARY, "crap", []))
        self.assertNotIn("--copy", tool_command(BINARY, "dry", []))


class CopySupportTest(unittest.TestCase):
    """带 --mutate 时先确认二进制认得 --copy：uml-viewer 1.0.0 还没有这个开关，不能静默跳过。"""

    def test_help_text_mentioning_the_flag_means_supported(self):
        self.assertTrue(copy_supported("  --copy <path>   Copy this directory into the work copy. May be repeated."))

    def test_a_help_text_without_the_flag_means_unsupported(self):
        self.assertFalse(copy_supported("Usage: mutator [options]\n  --scan  --mutate-all  --since-last-run\n"))


CRAP = """Function                       Namespace                             CC    Cov%     CRAP
----------------------------------------------------------------------------------------
trialGate                      core.ids                               4   N/A       N/A
newId                          core.ids                               1  100.0%     1.0
"""


class CrapUnmeasuredTest(unittest.TestCase):
    def test_functions_without_a_crap_score_are_reported(self):
        self.assertEqual(crap_unmeasured(CRAP), ["core.ids/trialGate"])

    def test_a_fully_measured_report_has_none(self):
        self.assertEqual(crap_unmeasured(CRAP.replace("N/A       N/A", "0.0%     20.0")), [])


class DryOffendersTest(unittest.TestCase):
    def test_a_pair_touching_a_changed_file_is_an_offence(self):
        self.assertEqual(dry_offenders(REPORT, {"server/src/y.rs"}), ["0.85 server/src/x.rs:10-30 <-> server/src/y.rs:40-61"])

    def test_pairs_between_untouched_files_are_existing_debt_not_offences(self):
        self.assertEqual(dry_offenders(REPORT, {"client/src/other.ts"}), [])


# 单行 EDN，格式同 client/.metrics/mutate/*.edn；hash 里塞一个右花括号，证明切分不会把字符串当结构。
SNAPSHOT = ("""{:version 1 :isolation :copy :source "src/ui/nodes.tsx" :namespace "ui.nodes" :outcomes {} :forms ["""
            """{:id "defn/Shell" :kind "defn" :file "src/ui/nodes.tsx" :line 1 :end-line 2 :hash "5c9a}a08" """
            """:killed 0 :survived 0 :uncovered 0 :sites 0} """
            """{:id "defn/Thumb" :kind "defn" :file "src/ui/nodes.tsx" :line 3 :end-line 4 :hash "ab8c" """
            """:killed 0 :survived 0 :uncovered 4 :sites 4} """
            """{:id "defn/Other" :kind "defn" :file "src/ui/other.tsx" :line 5 :end-line 6 :hash "def9" """
            """:killed 0 :survived 0 :uncovered 9 :sites 9}]}""")

SNAPSHOT_CORE = """{:version 1 :source "src/core/a.ts" :namespace "core.a" :forms [{:id "defn/a" :kind "defn" :file "src/core/a.ts" :line 1 :end-line 2 :hash "aa" :killed 1 :survived 0 :uncovered 3 :sites 4}]}"""


class MutationUncoveredTest(unittest.TestCase):
    """未覆盖变异点只统计本次改动的文件：快照目录里还有别的文件上次运行的记录（见 docs/adr/0022）。"""

    def test_only_forms_of_changed_files_count(self):
        self.assertEqual(mutation_uncovered(SNAPSHOT, {"src/ui/nodes.tsx"}), 4)
        self.assertEqual(mutation_uncovered(SNAPSHOT, {"src/ui/other.tsx"}), 9)
        self.assertEqual(mutation_uncovered(SNAPSHOT, {"src/ui/nodes.tsx", "src/ui/other.tsx"}), 13)

    def test_untouched_files_in_the_snapshot_are_existing_debt(self):
        self.assertEqual(mutation_uncovered(SNAPSHOT, {"src/elsewhere.ts"}), 0)

    def test_a_fully_covered_snapshot_has_no_gaps(self):
        self.assertEqual(mutation_uncovered(SNAPSHOT.replace(":uncovered 4", ":uncovered 0"), {"src/ui/nodes.tsx"}), 0)

    def test_an_empty_or_missing_forms_section_has_no_gaps(self):
        self.assertEqual(mutation_uncovered("{:version 1 :forms []}", {"src/ui/nodes.tsx"}), 0)
        self.assertEqual(mutation_uncovered("{:version 1 :source \"src/a.ts\"}", {"src/a.ts"}), 0)


class UncoveredSitesTest(unittest.TestCase):
    def test_snapshots_of_the_package_are_read_and_only_changed_files_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "client" / ".metrics" / "mutate"
            directory.mkdir(parents=True)
            (directory / "ui.nodes.edn").write_text(SNAPSHOT, encoding="utf-8")
            (directory / "core.a.edn").write_text(SNAPSHOT_CORE, encoding="utf-8")
            package = Package(root="client", source="src", excludes=())
            self.assertEqual(uncovered_sites(root, package, ["src/ui/nodes.tsx"]), 4)
            self.assertEqual(uncovered_sites(root, package, ["src/ui/nodes.tsx", "src/core/a.ts"]), 7)

    def test_a_package_without_snapshots_has_no_gaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(uncovered_sites(Path(tmp), Package(root="server", source="src", excludes=()), ["src/x.rs"]), 0)


class ViewerBinaryTest(unittest.TestCase):
    """二进制发现：UML_VIEWER_BIN 优先，其次 DSH 插件里 current.json 记的版本（见 docs/adr/0022）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dsh_home = self.root / "dsh"

    def install_plugin(self, version: str = "1.0.0") -> Path:
        plugin = self.dsh_home / "dsh-uml-viewer"
        binary = plugin / version / VIEWER_BINARY_NAME
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"")
        (plugin / "current.json").write_text(json.dumps({"version": version, "size": 1, "sha256": "0" * 64}),
                                             encoding="utf-8")
        return binary

    def test_the_plugin_install_under_dsh_home_is_the_default(self):
        installed = self.install_plugin("2.3.4")
        self.assertEqual(viewer_binary({"DSH_HOME": str(self.dsh_home)}), installed)

    def test_the_environment_variable_wins_over_the_plugin_install(self):
        self.install_plugin()
        configured = self.root / "custom" / VIEWER_BINARY_NAME
        configured.parent.mkdir()
        configured.write_bytes(b"")
        self.assertEqual(viewer_binary({"UML_VIEWER_BIN": str(configured), "DSH_HOME": str(self.dsh_home)}), configured)

    def test_a_version_record_without_the_binary_is_missing(self):
        plugin = self.dsh_home / "dsh-uml-viewer"
        plugin.mkdir(parents=True)
        (plugin / "current.json").write_text(json.dumps({"version": "9.9.9"}), encoding="utf-8")
        with self.assertRaises(ViewerMissing):
            viewer_binary({"DSH_HOME": str(self.dsh_home)})

    def test_a_missing_binary_says_how_to_install_it_or_point_at_it(self):
        with self.assertRaises(ViewerMissing) as caught:
            viewer_binary({"DSH_HOME": str(self.dsh_home)})
        self.assertIn("UML_VIEWER_BIN", str(caught.exception))
        self.assertIn("dsh-uml-viewer", str(caught.exception))

    def test_a_configured_path_that_is_not_a_file_is_an_error(self):
        missing = self.root / "nope"
        with self.assertRaises(ViewerMissing) as caught:
            viewer_binary({"UML_VIEWER_BIN": str(missing)})
        self.assertIn(str(missing), str(caught.exception))


class ChangedFilesTest(unittest.TestCase):
    def test_committed_since_base_and_uncommitted_changes_count_but_deletions_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            git(root, "init", "-q", "-b", "main")
            git(root, "config", "user.email", "t@example.com")
            git(root, "config", "user.name", "t")
            for name in ("kept.ts", "gone.ts", "edited.ts"):
                (root / name).write_text("x\n", encoding="utf-8")
            git(root, "add", ".")
            git(root, "commit", "-q", "-m", "base")
            base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
            (root / "edited.ts").write_text("y\n", encoding="utf-8")
            (root / "gone.ts").unlink()
            git(root, "commit", "-q", "-am", "work")
            (root / "new dir").mkdir()
            (root / "new dir" / "fresh.ts").write_text("z\n", encoding="utf-8")
            self.assertEqual(changed_files(root, base), ["edited.ts", "new dir/fresh.ts"])


if __name__ == "__main__":
    unittest.main()
