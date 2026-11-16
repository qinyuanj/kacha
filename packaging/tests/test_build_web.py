import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_web import SERVER_BINARY  # noqa: E402

PACKAGING = Path(__file__).resolve().parents[1]


def write_stub(tools: Path, name: str, body: str) -> None:
    """在 tools 下放一个名为 name 的命令桩，用当前 Python 执行 body。

    Windows 上命令解析只认 PATHEXT 里的扩展名，配一个 .cmd 包装；其它平台写带 shebang 的可执行脚本。
    """
    script = tools / f"{name}.py"
    script.write_text(body, encoding="utf-8")
    if os.name == "nt":
        (tools / f"{name}.cmd").write_text(f'@"{sys.executable}" "%~dp0{name}.py" %*\r\n', encoding="utf-8")
    else:
        launcher = tools / name
        launcher.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)


VALID_CHANGELOG = (
    "<!--\n写作约定，不显示。\n-->\n\n"
    "# 1.2.0\n\n## 修复\n\n- 改并发上限时，输到一半不会被改掉。\n\n"
    "# 1.1.0\n\n## 新增\n\n- 「份数」：一次出多张图。\n"
)


def make_repo(root: Path, version: str, changelog: str, desktop_version: str | None = None) -> dict[str, str]:
    """在 root 下搭一个最小仓库：打包脚本与门禁模块、两张清单、更新说明，以及会留下调用记录的 npm/cargo 桩。

    desktop_version 默认与服务端清单同号；传另一个值即可搭出「两张清单不同号」的仓库。

    返回运行打包脚本所用的环境变量；桩每次被调用都会在 root/calls.log 记一行。
    门禁规则本身在 test_release_gate 里测，这里只测入口：门禁不通过就不构建。
    """
    (root / "packaging").mkdir()
    for name in ("build_web.py", "release_gate.py"):
        shutil.copy2(PACKAGING / name, root / "packaging" / name)
    (root / "client").mkdir()
    (root / "server").mkdir()
    (root / "server" / "Cargo.toml").write_text(
        f'[package]\nname = "kacha-server"\nversion = "{version}"\nedition = "2021"\n', encoding="utf-8"
    )
    (root / "mygo.config.ts").write_text(
        f'export default {{\n  name: "Kacha",\n  version: "{desktop_version or version}",\n}};\n', encoding="utf-8"
    )
    (root / "docs" / "release").mkdir(parents=True)
    (root / "docs" / "release" / "web-changelog.md").write_text(changelog, encoding="utf-8")
    tools = root / "tools"
    tools.mkdir()
    log = (root / "calls.log").as_posix()
    write_stub(
        tools,
        "npm",
        "from pathlib import Path\n"
        f"open({log!r}, 'a').write('npm\\n')\n"
        "Path('dist/assets').mkdir(parents=True, exist_ok=True)\n"
        "Path('dist/index.html').write_text('<html><script src=\"./assets/index.js\"></script></html>')\n"
        "Path('dist/assets/index.js').write_text('js')\n",
    )
    write_stub(
        tools,
        "cargo",
        "from pathlib import Path\n"
        f"open({log!r}, 'a').write('cargo\\n')\n"
        "Path('target/release').mkdir(parents=True, exist_ok=True)\n"
        f"Path('target/release/{SERVER_BINARY}').write_bytes(b'server')\n",
    )
    return dict(os.environ, PATH=f"{tools}{os.pathsep}{os.environ['PATH']}", PYTHONIOENCODING="utf-8")


def run_build(root: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(root / "packaging" / "build_web.py"), *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


class BuildWebGateTest(unittest.TestCase):
    """打包入口在构建前过门禁：更新说明缺当前版本就拒绝，构建命令一次都不跑、部署目录不动。"""

    def test_rejects_without_producing_a_deploy_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root, "1.3.0", "# 1.2.0\n\n## 修复\n\n- 旧版本的一条。\n")
            result = run_build(root, env)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("1.3.0", result.stderr)
            self.assertIn("更新说明", result.stderr)
            self.assertFalse((root / "release" / "kacha-web").exists())
            self.assertFalse((root / "calls.log").exists(), "检查失败前不应运行任何构建命令")

    def test_rejects_when_the_two_manifests_differ(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root, "1.3.0", VALID_CHANGELOG, desktop_version="0.2.0")
            result = run_build(root, env)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("1.3.0", result.stderr)
            self.assertIn("0.2.0", result.stderr)
            self.assertFalse((root / "release" / "kacha-web").exists())
            self.assertFalse((root / "calls.log").exists(), "检查失败前不应运行任何构建命令")

    def test_keeps_previous_deploy_directory_when_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root, "1.3.0", VALID_CHANGELOG)
            previous = root / "release" / "kacha-web" / "SHA256SUMS"
            previous.parent.mkdir(parents=True)
            previous.write_text("上一次的产物", encoding="utf-8")
            result = run_build(root, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(previous.read_text(encoding="utf-8"), "上一次的产物")
            self.assertFalse((root / "calls.log").exists())


class BuildWebCliTest(unittest.TestCase):
    def test_collects_server_and_relative_static_assets_without_toolchain_at_runtime(self):
        binary = SERVER_BINARY
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root, "1.2.0", VALID_CHANGELOG)
            result = run_build(root, env, "--skip-npm-ci")
            self.assertEqual(result.returncode, 0, result.stderr)
            output = root / "release" / "kacha-web"
            self.assertEqual((output / binary).read_bytes(), b"server")
            self.assertEqual((output / "static" / "assets" / "index.js").read_text(), "js")
            self.assertIn('src="./assets/index.js"', (output / "static" / "index.html").read_text())
            checksums = (output / "SHA256SUMS").read_text()
            self.assertIn(binary, checksums)
            self.assertIn("static/index.html", checksums)


if __name__ == "__main__":
    unittest.main()
