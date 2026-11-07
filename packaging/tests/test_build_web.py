import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


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


class BuildWebCliTest(unittest.TestCase):
    def test_collects_server_and_relative_static_assets_without_toolchain_at_runtime(self):
        binary = "kacha-server.exe" if os.name == "nt" else "kacha-server"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "packaging").mkdir()
            script = Path(__file__).parents[1] / "build_web.py"
            shutil.copy2(script, root / "packaging" / script.name)
            (root / "client").mkdir()
            (root / "server").mkdir()
            tools = root / "tools"
            tools.mkdir()
            write_stub(
                tools,
                "npm",
                "from pathlib import Path\n"
                "Path('dist/assets').mkdir(parents=True, exist_ok=True)\n"
                "Path('dist/index.html').write_text('<html><script src=\"./assets/index.js\"></script></html>')\n"
                "Path('dist/assets/index.js').write_text('js')\n",
            )
            write_stub(
                tools,
                "cargo",
                "from pathlib import Path\n"
                "Path('target/release').mkdir(parents=True, exist_ok=True)\n"
                f"Path('target/release/{binary}').write_bytes(b'server')\n",
            )

            env = dict(os.environ, PATH=f"{tools}{os.pathsep}{os.environ['PATH']}")
            result = subprocess.run(
                [sys.executable, str(root / "packaging" / "build_web.py"), "--skip-npm-ci"],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
            )
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
