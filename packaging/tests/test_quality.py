"""质量门禁的判定：改动集只取业务源码，dryer 配对只在碰到改动文件时算违规，范围只有 uml-quality.json 一处。"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quality import Scope, changed_files, crap_unmeasured, dry_offenders, in_scope, mutation_gaps, packages  # noqa: E402

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


TABLE = """Function  Namespace   Killed  Survived  Uncovered  Sites   Score
-----------------------------------------------------------------
place     core.board        4         0          {uncovered}      5  100.0%
-----------------------------------------------------------------
Total                       4         0          {uncovered}      5  100.0%
"""


class MutationGapsTest(unittest.TestCase):
    def test_uncovered_sites_in_any_results_table_are_gaps(self):
        self.assertEqual(mutation_gaps(TABLE.format(uncovered=0) + TABLE.format(uncovered=2)), 2)

    def test_a_fully_killed_run_has_no_gaps(self):
        self.assertEqual(mutation_gaps(TABLE.format(uncovered=0)), 0)


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
