#!/usr/bin/env python3
"""桌面验证：预检、打包脚本单测、前端单测/类型/死代码、Go 测试、debug 构建与前端质量门禁。

不运行 e2e。--quality 额外运行前端变异测试；--base 显式指定质量比较基线。
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BUILD_OUTPUTS = (Path("build"), Path("client") / "target")
QUALITY = [sys.executable, "packaging/quality.py"]
COMMANDS = (
    [sys.executable, "-m", "unittest", "discover", "-s", "packaging/tests"],
    ["npm", "--prefix", "client", "test"],
    ["npm", "--prefix", "client", "run", "typecheck"],
    ["npm", "--prefix", "client", "run", "lint:dead"],
    ["go", "test", "./..."],
    [sys.executable, "packaging/build_desktop.py", "--debug", "--skip-install"],
    QUALITY,
)


def commands(argv: list[str]) -> list[list[str]]:
    """只接受当前验证入口的参数，避免旧参数被静默忽略。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--quality", action="store_true")
    parser.add_argument("--base")
    args = parser.parse_args(argv)
    quality = [*QUALITY, *(["--mutate"] if args.quality else [])]
    if args.base:
        quality += ["--base", args.base]
    return [quality if command is QUALITY else command for command in COMMANDS]


def integrity_problems(root: Path) -> list[Path]:
    """Windows 输出目录继承 Low 标签时，程序不能写临时目录或创建符号链接。"""
    if os.name != "nt":
        return []
    problems = []
    for relative in BUILD_OUTPUTS:
        target = root / relative
        existing = next(p for p in (target, *target.parents) if p.exists())
        label = subprocess.run(["icacls", str(existing)], capture_output=True, text=True, errors="replace", check=True).stdout
        if "Mandatory Label\\Low Mandatory Level" in label:
            problems.append(target)
    return problems


def preflight(root: Path) -> int:
    """只报告完整性问题与修复命令，不创建或修改目录。"""
    problems = integrity_problems(root)
    if not problems:
        return 0
    print("以下构建输出目录带 Low 完整性标签，程序可能无法写临时文件或创建符号链接：", file=sys.stderr)
    for path in problems:
        print(f"  icacls {path} /setintegritylevel '(OI)(CI)M'", file=sys.stderr)
    print("执行上面的命令后重跑（见 packaging/README.md「验证」）。", file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    selected = commands(argv)
    code = preflight(ROOT)
    if code or "--preflight" in argv:
        return code
    failed = []
    for command in selected:
        line = " ".join(command)
        print(f"\n=== {line}", flush=True)
        executable = shutil.which(command[0])
        if executable is None or subprocess.run([executable, *command[1:]], cwd=ROOT).returncode != 0:
            failed.append(line)
    print("\n=== 汇总")
    for command in selected:
        line = " ".join(command)
        print(f"{'失败' if line in failed else '通过'}  {line}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
