"""质量工具安装的校验：装的必须正好是固定的四个 commit，否则预检拦下并说明怎么重装。"""

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from install_quality_tools import PINS, install_problems  # noqa: E402


def write_install(home: Path, commits: dict[str, str]) -> None:
    (home / ".uml-viewer").mkdir()
    record = {"version": 1, "repositories": {tool: {"commit": commit} for tool, commit in commits.items()}}
    (home / ".uml-viewer" / "install.json").write_text(json.dumps(record), encoding="utf-8")


class InstallProblemsTest(unittest.TestCase):
    def test_the_pinned_commits_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_install(Path(tmp), PINS)
            self.assertEqual(install_problems(Path(tmp)), [])

    def test_a_missing_install_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(len(install_problems(Path(tmp))), 1)

    def test_each_tool_at_another_commit_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_install(Path(tmp), {**PINS, "mutator": "0" * 40, "dryer": "1" * 40})
            problems = install_problems(Path(tmp))
        self.assertEqual(len(problems), 2)
        self.assertIn("mutator", problems[0])
        self.assertIn("dryer", problems[1])


if __name__ == "__main__":
    unittest.main()
