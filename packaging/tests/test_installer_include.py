"""安装器钩子：自动更新的静默安装装完要自己把 Kacha 重新打开。

真正的动作由 NSIS 在装完那一该执行，Go 测试看不到；这里锁住三件事，
让改动不会只落在某一侧：配置链上了钩子、钩子启动的是安装目录里的应用本体、
Go 传的参数名与钩子读的参数名是同一个。
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

CONFIG = ROOT / "mygo.config.ts"
HOOK = ROOT / "installer" / "installer.nsh"
SERVICE = ROOT / "desktop" / "internal" / "updateservice" / "service.go"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class InstallerIncludeTest(unittest.TestCase):
    def test_config_points_at_the_hook(self) -> None:
        match = re.search(r'installerInclude:\s*"([^"]+)"', read(CONFIG))
        self.assertIsNotNone(match, "mygo.config.ts 没有配置 windows.installerInclude")
        path = ROOT / match.group(1)
        self.assertTrue(path.is_file(), f"{path} 不存在，mygo build 会因此失败")

    def test_hook_relaunches_the_installed_app(self) -> None:
        hook = read(HOOK)
        for macro in ("customInit", "customInstall"):
            self.assertIn(f"!macro {macro}", hook, f"钩子没有定义 {macro}")
        name = re.search(r'name:\s*"([^"]+)"', read(CONFIG)).group(1)
        self.assertIn(
            f'Exec \'"$INSTDIR\\{name}.exe"\'',
            hook,
            "装完要启动安装目录里的应用本体",
        )

    def test_both_sides_use_the_same_flag(self) -> None:
        flag = re.search(r'relaunchFlag\s*=\s*"([^"]+)"', read(SERVICE))
        self.assertIsNotNone(flag, "service.go 里没有 relaunchFlag")
        self.assertIn(
            f'"{flag.group(1)}"',
            read(HOOK),
            f"安装器钩子没读 {flag.group(1)}",
        )


if __name__ == "__main__":
    unittest.main()
