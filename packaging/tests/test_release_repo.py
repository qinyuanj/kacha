"""发行仓路径只在三处声明，测试守住它们一致。"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = (
    ("desktop/internal/updateservice/service.go", r'OwnerRepo\s*=\s*"([^"]+)"'),
    ("packaging/publish_release.py", r'OWNER_REPO\s*=\s*"([^"]+)"'),
    ("tools/signrelease/main.go", r'ownerRepo\s*=\s*"([^"]+)"'),
)


class ReleaseRepoTest(unittest.TestCase):
    def test_all_declarations_agree(self):
        values = []
        for relative, pattern in SOURCES:
            text = (ROOT / relative).read_text(encoding="utf-8")
            found = re.findall(pattern, text)
            self.assertEqual(len(found), 1, f"{relative}: 期望恰好一处声明，得到 {found}")
            values.append(found[0])
        self.assertEqual(len(set(values)), 1, f"发行仓路径不一致：{dict(zip([s[0] for s in SOURCES], values))}")

    def test_declared_repo_is_the_cd_repo(self):
        relative, pattern = SOURCES[0]
        value = re.findall(pattern, (ROOT / relative).read_text(encoding="utf-8"))[0]
        self.assertEqual(value, "qinyuanj/kacha-cd")
