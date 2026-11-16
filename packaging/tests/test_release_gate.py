import sys
from pathlib import Path
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from release_gate import check_release_notes, check_version_line, parse_config_version  # noqa: E402


def write_repo(root: Path, *, server: str | None = "1.5.0", desktop: str | None = "1.5.0", notes: str = "") -> Path:
    """最小仓库：两张清单与更新说明。传 None 表示那张清单里不写版本。"""
    (root / "server").mkdir(parents=True, exist_ok=True)
    (root / "docs" / "release").mkdir(parents=True, exist_ok=True)
    manifest = '[package]\nname = "kacha-server"\n' + (f'version = "{server}"\n' if server else "")
    (root / "server" / "Cargo.toml").write_text(manifest, encoding="utf-8")
    config = 'export default {\n  name: "Kacha",\n' + (f'  version: "{desktop}",\n' if desktop else "") + "};\n"
    (root / "mygo.config.ts").write_text(config, encoding="utf-8")
    (root / "docs" / "release" / "web-changelog.md").write_text(notes, encoding="utf-8")
    return root


VALID_NOTES = "# 1.5.0\n\n## 改进\n\n- 版本号接在 1.4.0 后面。\n\n# 1.4.0\n\n## 新增\n\n- 旧版本的一条。\n"


class ReleaseNotesGateTest(unittest.TestCase):
    """更新说明门禁：当前版本要有自己的一节，且该节「新增 / 改进 / 修复」下至少一条。"""

    def assert_rejected(self, notes: str, version: str = "1.5.0") -> str:
        with tempfile.TemporaryDirectory() as tmp:
            root = write_repo(Path(tmp), server=version, desktop=version, notes=notes)
            with self.assertRaises(SystemExit) as caught:
                check_release_notes(root, version)
            message = str(caught.exception)
            self.assertIn("更新说明", message)
            self.assertIn(version, message)
            return message

    def test_accepts_the_section_for_the_current_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_repo(Path(tmp), notes=VALID_NOTES)
            check_release_notes(root, "1.5.0")

    def test_rejects_a_changelog_without_the_current_version(self):
        self.assert_rejected("# 1.4.0\n\n## 修复\n\n- 旧版本的一条。\n")

    def test_heading_must_equal_the_version_exactly(self):
        self.assert_rejected("# v1.5.0\n\n## 新增\n\n- 一条。\n")

    def test_items_outside_known_groups_do_not_count(self):
        self.assert_rejected("# 1.5.0\n\n- 没有分组的一条。\n\n## 其他\n\n- 未知分组的一条。\n")

    def test_section_inside_an_html_comment_does_not_count(self):
        self.assert_rejected("<!--\n# 1.5.0\n\n## 新增\n\n- 还没定稿。\n-->\n\n# 1.4.0\n\n## 修复\n\n- 旧版本的一条。\n")

    def test_rejects_a_section_without_items(self):
        self.assert_rejected("# 1.5.0\n\n## 新增\n\n# 1.4.0\n\n## 修复\n\n- 旧版本的一条。\n")

    def test_items_of_other_versions_do_not_count(self):
        self.assert_rejected("# 1.5.0\n\n# 1.4.0\n\n## 新增\n\n- 旧版本的一条。\n")


class VersionLineGateTest(unittest.TestCase):
    """版本线门禁：服务端清单与桌面配置同号，不同号时说清两边各是什么。"""

    def test_returns_the_shared_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_repo(Path(tmp), server="1.5.0", desktop="1.5.0")
            self.assertEqual(check_version_line(root), "1.5.0")

    def test_names_both_sides_when_they_differ(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_repo(Path(tmp), server="1.5.0", desktop="0.2.0")
            with self.assertRaises(SystemExit) as caught:
                check_version_line(root)
            message = str(caught.exception)
            self.assertIn("1.5.0", message)
            self.assertIn("0.2.0", message)
            self.assertIn("server/Cargo.toml", message)
            self.assertIn("mygo.config.ts", message)

    def test_reports_the_desktop_config_without_a_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_repo(Path(tmp), desktop=None)
            with self.assertRaises(SystemExit) as caught:
                check_version_line(root)
            self.assertIn("mygo.config.ts", str(caught.exception))

    def test_reports_the_server_manifest_without_a_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_repo(Path(tmp), server=None)
            with self.assertRaises(SystemExit) as caught:
                check_version_line(root)
            self.assertIn("server/Cargo.toml", str(caught.exception))


class ConfigVersionParsingTest(unittest.TestCase):
    """桌面配置的版本解析：配置是普通对象，版本只在那一处定义。"""

    def test_reads_the_version(self):
        self.assertEqual(parse_config_version('export default {\n  version: "1.5.0",\n};\n'), "1.5.0")

    def test_accepts_single_quotes(self):
        self.assertEqual(parse_config_version("export default {\n  version: '1.5.0',\n};\n"), "1.5.0")

    def test_missing_version_is_none(self):
        self.assertIsNone(parse_config_version('export default {\n  name: "Kacha",\n};\n'))


if __name__ == "__main__":
    unittest.main()
