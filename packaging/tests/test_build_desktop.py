import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_desktop  # noqa: E402


def write_stub(tools: Path, name: str, body: str) -> None:
    """在 tools 下放一个名为 name 的命令桩，用当前 Python 执行 body（与 test_build_web 同一做法）。"""
    script = tools / f"{name}.py"
    script.write_text(body, encoding="utf-8")
    if os.name == "nt":
        (tools / f"{name}.cmd").write_text(f'@"{sys.executable}" "%~dp0{name}.py" %*\r\n', encoding="utf-8")
    else:
        launcher = tools / name
        launcher.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)


CONFIG = 'export default {\n  name: "Kacha",\n  version: "0.1.0",\n};\n'


def make_repo(root: Path) -> dict[str, str]:
    """最小仓库：mygo.config.ts、打包脚本与会写产物、记下调用参数的 go 桩。"""
    (root / "packaging").mkdir()
    script = Path(__file__).parents[1] / "build_desktop.py"
    shutil.copy2(script, root / "packaging" / script.name)
    (root / "mygo.config.ts").write_text(CONFIG, encoding="utf-8")
    (root / "client").mkdir()
    tools = root / "tools"
    tools.mkdir()
    log = (root / "calls.log").as_posix()
    write_stub(
        tools,
        "npm",
        "import sys\n"
        "from pathlib import Path\n"
        f"open({log!r}, 'a').write('npm ' + ' '.join(sys.argv[1:]) + '\\n')\n",
    )
    write_stub(
        tools,
        "go",
        "import os, sys\n"
        "from pathlib import Path\n"
        f"open({log!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
        "args = sys.argv[1:]\n"
        "if args[:1] == ['version']:\n"
        "    print('go version go1.27.3 windows/amd64')\n"
        "elif args[:3] == ['tool', 'mygo', 'version']:\n"
        "    print('mygo 0.9.0')\n"
        "else:\n"
        "    out = Path('build/windows-amd64')\n"
        "    out.mkdir(parents=True, exist_ok=True)\n"
        "    (out / 'Kacha.exe').write_bytes(b'exe')\n"
        "    print('  √ Built Kacha 0.1.0 in 6.8s')\n",
    )
    return dict(os.environ, PATH=f"{tools}{os.pathsep}{os.environ['PATH']}", PYTHONIOENCODING="utf-8")


def run_build(root: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(root / "packaging" / "build_desktop.py"), *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


class VersionParsingTest(unittest.TestCase):
    """版本解析：从命令输出里取出要记录的那一段，读不到就是 None。"""

    def test_mygo_version(self):
        self.assertEqual(build_desktop.parse_mygo_version("mygo 0.9.0\n"), "0.9.0")

    def test_mygo_version_missing(self):
        self.assertIsNone(build_desktop.parse_mygo_version(""))

    def test_go_version(self):
        self.assertEqual(build_desktop.parse_go_version("go version go1.27.3 windows/amd64\n"), "go1.27.3")

    def test_go_version_missing(self):
        self.assertIsNone(build_desktop.parse_go_version("something else"))

    def test_webview2_version(self):
        output = "\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\n    pv    REG_SZ    158.0.4370.21\n\n"
        self.assertEqual(build_desktop.parse_webview2_version(output), "158.0.4370.21")

    def test_webview2_missing(self):
        self.assertIsNone(build_desktop.parse_webview2_version("错误: 系统找不到指定的注册表项或值。"))

    def test_config_version(self):
        self.assertEqual(build_desktop.parse_config_version(CONFIG), "0.1.0")


class BuildDesktopTest(unittest.TestCase):
    """打包入口：跑固定版本的 CLI，记录版本，写出产物路径与构建记录。"""

    def test_records_versions_and_prints_exe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            result = run_build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            exe = root / "build" / "windows-amd64" / "Kacha.exe"
            self.assertTrue(exe.exists())
            self.assertIn(str(exe), result.stdout)

            info = json.loads((root / "build" / "windows-amd64" / "build-info.json").read_text(encoding="utf-8"))
            self.assertEqual(info["app"], "Kacha")
            self.assertEqual(info["version"], "0.1.0")
            self.assertEqual(info["mygo"], "0.9.0")
            self.assertEqual(info["go"], "go1.27.3")
            self.assertIn("webview2", info)
            self.assertEqual(info["platform"], "windows/amd64")
            self.assertEqual(info["exe"], "build/windows-amd64/Kacha.exe")

    def test_pins_cli_and_skips_installer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            result = run_build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = (root / "calls.log").read_text(encoding="utf-8").splitlines()
            build = [line for line in calls if line.startswith("tool mygo build")]
            self.assertEqual(len(build), 1, calls)
            self.assertIn("-platform windows/amd64", build[0])
            self.assertIn("-skip-installer", build[0])

    def test_fails_when_exe_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            (root / "tools" / "go.py").write_text(
                "import sys\n"
                "if sys.argv[1:2] == ['version']:\n"
                "    print('go version go1.27.3 windows/amd64')\n"
                "elif sys.argv[1:4] == ['tool', 'mygo', 'version']:\n"
                "    print('mygo 0.9.0')\n",
                encoding="utf-8",
            )
            result = run_build(root, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Kacha.exe", result.stderr)
