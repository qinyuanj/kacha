"""验证入口的预检：构建输出目录会让程序以 Low 完整性级别运行时，必须在跑测试前指出来。"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from verify import integrity_problems  # noqa: E402


@unittest.skipUnless(os.name == "nt", "完整性标签只在 Windows 上存在")
class IntegrityPreflightTest(unittest.TestCase):
    def test_build_outputs_under_a_low_labelled_root_are_reported_even_before_they_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server").mkdir()
            subprocess.run(["icacls", str(root), "/setintegritylevel", "(OI)(CI)L"], check=True, capture_output=True)
            self.assertEqual(integrity_problems(root), [root / "server" / "target", root / "release"])

    def test_medium_build_outputs_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server" / "target").mkdir(parents=True)
            self.assertEqual(integrity_problems(root), [])


if __name__ == "__main__":
    unittest.main()
