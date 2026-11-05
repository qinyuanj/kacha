import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


class BuildWebCliTest(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "npm/cargo 桩是 POSIX sh 脚本，Windows 上脚本会调用 npm.cmd 与 cargo.exe")
    def test_collects_server_and_relative_static_assets_without_toolchain_at_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "packaging").mkdir()
            script = Path(__file__).parents[1] / "build_web.py"
            shutil.copy2(script, root / "packaging" / script.name)
            (root / "client").mkdir()
            (root / "server").mkdir()
            tools = root / "tools"
            tools.mkdir()
            npm = tools / "npm"
            npm.write_text(
                "#!/bin/sh\n"
                "mkdir -p dist/assets\n"
                "printf '%s' '<html><script src=\"./assets/index.js\"></script></html>' > dist/index.html\n"
                "printf 'js' > dist/assets/index.js\n",
                encoding="utf-8",
            )
            cargo = tools / "cargo"
            cargo.write_text(
                "#!/bin/sh\n"
                "mkdir -p target/release\n"
                "printf 'server' > target/release/kacha-server\n",
                encoding="utf-8",
            )
            for tool in (npm, cargo):
                tool.chmod(tool.stat().st_mode | stat.S_IXUSR)

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
            self.assertEqual((output / "kacha-server").read_bytes(), b"server")
            self.assertEqual((output / "static" / "assets" / "index.js").read_text(), "js")
            self.assertIn('src="./assets/index.js"', (output / "static" / "index.html").read_text())
            checksums = (output / "SHA256SUMS").read_text()
            self.assertIn("kacha-server", checksums)
            self.assertIn("static/index.html", checksums)


if __name__ == "__main__":
    unittest.main()
