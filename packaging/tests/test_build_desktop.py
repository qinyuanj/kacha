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

PACKAGING = Path(__file__).resolve().parents[1]

CONFIG = 'export default {\n  name: "Kacha",\n  version: "0.1.0",\n};\n'

VALID_CHANGELOG = "# 0.1.0\n\n## 新增\n\n- 一条。\n"


def write_stub(tools: Path, name: str, body: str) -> None:
    """在 tools 下放一个名为 name 的命令桩，用当前 Python 执行 body。"""
    script = tools / f"{name}.py"
    script.write_text(body, encoding="utf-8")
    if os.name == "nt":
        (tools / f"{name}.cmd").write_text(f'@"{sys.executable}" "%~dp0{name}.py" %*\r\n', encoding="utf-8")
    else:
        launcher = tools / name
        launcher.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)


def make_repo(root: Path, changelog: str = VALID_CHANGELOG) -> dict[str, str]:
    """最小仓库：打包脚本与门禁模块、桌面清单、更新说明，与会写产物、记下调用参数的 go 桩。

    门禁规则本身在 test_release_gate 里测，这里只测入口：门禁不通过就不构建。
    """
    (root / "packaging").mkdir()
    for name in ("build_desktop.py", "release_gate.py"):
        shutil.copy2(PACKAGING / name, root / "packaging" / name)
    (root / "mygo.config.ts").write_text(CONFIG, encoding="utf-8")
    (root / "docs" / "release").mkdir(parents=True)
    (root / "docs" / "release" / "changelog.md").write_text(changelog, encoding="utf-8")
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
        f"open({log!r}, 'a').write('env GOOS=' + os.environ.get('GOOS', '') + ' GOARCH=' + os.environ.get('GOARCH', '') + ' CGO_ENABLED=' + os.environ.get('CGO_ENABLED', '') + '\\n')\n"
        f"open({log!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
        "args = sys.argv[1:]\n"
        "if args[:1] == ['version']:\n"
        "    print('go version go1.27.3 windows/amd64')\n"
        "elif args[:3] == ['tool', 'mygo', 'version']:\n"
        "    print('mygo 0.9.0')\n"
        "elif args[:1] == ['build']:\n"
        "    out = Path(args[args.index('-o') + 1])\n"
        "    out.mkdir(parents=True, exist_ok=True)\n"
        "    (out / 'feedbackrelay.exe').write_bytes(b'relay')\n"
        "else:\n"
        "    base = args[args.index('-o') + 1] if '-o' in args else 'build'\n"
        "    out = Path(base) / 'windows-amd64'\n"
        "    out.mkdir(parents=True, exist_ok=True)\n"
        "    (out / 'Kacha.exe').write_bytes(b'exe')\n"
        "    if '-debug' not in args and '-skip-installer' not in args:\n"
        "        (out / 'kacha-setup-0.1.0-amd64.exe').write_bytes(b'installer')\n"
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


def assert_prints_produced_exe(case: unittest.TestCase, root: Path, stdout: str) -> None:
    """断言脚本打印的正是它实际产出的 exe。

    只核对仓库内的相对位置（build/windows-amd64/Kacha.exe）并确认该文件确实存在，
    不比对临时目录的绝对路径：在 Windows runner 上，构建子进程经 __file__.resolve()
    得到的临时目录可能与测试进程拼成不同的用户段（如 RUNNER~1 与 runneradmin），
    绝对路径字符串不同却指向同一个产物，按字符串相等断言会误报失败。
    """
    relative_exe = os.path.join("build", "windows-amd64", "Kacha.exe")
    printed = [
        line.split("客户端：", 1)[1].strip()
        for line in stdout.splitlines()
        if "客户端：" in line
    ]
    case.assertTrue(printed, f"脚本没有打印客户端路径：{stdout!r}")
    case.assertTrue(
        printed[0].endswith(relative_exe),
        f"打印的路径不是产出的 exe（应以 {relative_exe} 结尾）：{printed[0]!r}",
    )
    produced = root / relative_exe
    case.assertTrue(produced.exists(), f"打印的产物不存在：{produced}")


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


class BuildDesktopGateTest(unittest.TestCase):
    """打包入口在构建前过门禁：更新说明缺当前版本就拒绝，构建命令一次都不跑。"""

    def test_rejects_without_release_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root, "# 0.0.9\n\n## 修复\n\n- 旧版本的一条。\n")
            result = run_build(root, env)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("更新说明", result.stderr)
            self.assertIn("0.1.0", result.stderr)
            self.assertFalse((root / "build" / "windows-amd64" / "Kacha.exe").exists())
            self.assertFalse((root / "calls.log").exists(), "门禁失败前不应运行任何构建命令")

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
            # 不比对临时目录的绝对路径（见 assert_prints_produced_exe）：runner 上两个进程
            # 可能把同一临时根拼成不同的用户段，绝对路径字符串相等并不代表产物不同。
            assert_prints_produced_exe(self, root, result.stdout)

            info = json.loads((root / "build" / "windows-amd64" / "build-info.json").read_text(encoding="utf-8"))
            self.assertEqual(info["app"], "Kacha")
            self.assertEqual(info["version"], "0.1.0")
            self.assertEqual(info["mygo"], "0.9.0")
            self.assertEqual(info["go"], "go1.27.3")
            self.assertIn("webview2", info)
            self.assertEqual(info["platform"], "windows/amd64")
            self.assertEqual(info["exe"], "build/windows-amd64/Kacha.exe")

    def test_release_build_uses_native_installer_and_signs_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            result = run_build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = (root / "calls.log").read_text(encoding="utf-8").splitlines()
            build = [line for line in calls if line.startswith("tool mygo build")]
            self.assertEqual(len(build), 1, calls)
            self.assertIn("-platform windows/amd64", build[0])
            self.assertNotIn("-skip-installer", build[0])
            self.assertIn("kacha-setup-0.1.0-amd64.exe", (root / "build" / "windows-amd64" / "build-info.json").read_text(encoding="utf-8"))

    def test_debug_build_keeps_release_output_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            result = run_build(root, env, "--debug", "--skip-install")
            self.assertEqual(result.returncode, 0, result.stderr)
            info = json.loads((root / "build/debug/windows-amd64/build-info.json").read_text(encoding="utf-8"))
            self.assertEqual(info["profile"], "debug")
            self.assertEqual(info["exe"], "build/debug/windows-amd64/Kacha.exe")
            self.assertFalse((root / "build/windows-amd64").exists())
            calls = (root / "calls.log").read_text(encoding="utf-8")
            self.assertIn("-debug -o build/debug", calls)
            self.assertNotIn("npm ci", calls)

    def test_release_build_produces_relay_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            result = run_build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            relay = root / "build" / "windows-amd64" / "feedbackrelay.exe"
            self.assertTrue(relay.exists(), f"没有产出 {relay}")
            calls = (root / "calls.log").read_text(encoding="utf-8")
            self.assertIn("build -o build/windows-amd64/feedbackrelay.exe ./desktop/cmd/feedbackrelay", calls)
            self.assertIn("env GOOS=windows GOARCH=amd64 CGO_ENABLED=0", calls)
            info = json.loads((root / "build" / "windows-amd64" / "build-info.json").read_text(encoding="utf-8"))
            self.assertEqual(info["relay"], "build/windows-amd64/feedbackrelay.exe")
            self.assertIn("中继", result.stdout)

    def test_debug_build_produces_relay_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            result = run_build(root, env, "--debug", "--skip-install")
            self.assertEqual(result.returncode, 0, result.stderr)
            relay = root / "build" / "debug" / "windows-amd64" / "feedbackrelay.exe"
            self.assertTrue(relay.exists(), f"没有产出 {relay}")
            calls = (root / "calls.log").read_text(encoding="utf-8")
            self.assertIn("build -o build/debug/windows-amd64/feedbackrelay.exe ./desktop/cmd/feedbackrelay", calls)
            info = json.loads((root / "build/debug/windows-amd64/build-info.json").read_text(encoding="utf-8"))
            self.assertEqual(info["relay"], "build/debug/windows-amd64/feedbackrelay.exe")

    def test_build_keeps_runtime_token_out_of_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = make_repo(root)
            secret = "fixture-runtime-secret"
            env["FEEDBACK_GITEA_TOKEN"] = secret
            result = run_build(root, env, "--debug", "--skip-install")
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = (root / "calls.log").read_text(encoding="utf-8")
            info = (root / "build/debug/windows-amd64/build-info.json").read_text(encoding="utf-8")
            self.assertNotIn(secret, result.stdout + result.stderr + calls + info)

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


class PrintedExeAssertionTest(unittest.TestCase):
    """打印路径断言本身：被拼成不同临时根的同一产物要放行，错误路径要能识别。"""

    def made_repo(self, tmp: str) -> Path:
        root = Path(tmp)
        (root / "build" / "windows-amd64").mkdir(parents=True)
        (root / "build" / "windows-amd64" / "Kacha.exe").write_bytes(b"exe")
        return root

    def test_accepts_differently_spelled_temp_root(self):
        # 临时根被拼成另一个用户段但指向同一产物：不按绝对路径字符串比对，应当通过。
        with tempfile.TemporaryDirectory() as tmp:
            root = self.made_repo(tmp)
            other_root = Path("C:/Users/other/AppData/Local/Temp/tmp8l75n9li")
            printed = other_root / "build" / "windows-amd64" / "Kacha.exe"
            stdout = "  √ Built Kacha 0.1.0 in 6.8s\n客户端：" + str(printed) + "\n"
            assert_prints_produced_exe(self, root, stdout)

    def test_rejects_wrong_printed_path(self):
        # 产物存在但脚本打印了错路径：断言必须失败，防止改宽后形同虚设。
        with tempfile.TemporaryDirectory() as tmp:
            root = self.made_repo(tmp)
            wrong = root / "build" / "windows-amd64" / "Wrong.exe"
            with self.assertRaises(AssertionError):
                assert_prints_produced_exe(self, root, "客户端：" + str(wrong) + "\n")


if __name__ == "__main__":
    unittest.main()
