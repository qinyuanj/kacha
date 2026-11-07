#!/usr/bin/env python3
"""提交前的全套验证：预检构建输出目录，再依次跑打包脚本单测、前端单测、类型检查、e2e 与服务端测试。

只依赖 Python 标准库。每条命令都跑完再汇总（cargo 带 --no-fail-fast），任一失败即以非 0 退出。
用法：python packaging\\verify.py
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent

# 编译和复制出来的程序放在这里，文件的完整性标签从目录继承。
BUILD_OUTPUTS = (Path("server") / "target", Path("release"))

COMMANDS = (
    [sys.executable, "-m", "unittest", "discover", "-s", "packaging/tests"],
    ["npm", "--prefix", "client", "test"],
    ["npm", "--prefix", "client", "run", "typecheck"],
    ["npm", "--prefix", "client", "run", "test:e2e", "--", "--workers=4"],
    ["cargo", "test", "--manifest-path", "server/Cargo.toml", "--no-fail-fast"],
)


def integrity_problems(root: Path) -> list[Path]:
    """返回 root 下会让程序以 Low 完整性级别运行的构建输出目录。

    Windows 启动程序时，进程的完整性级别不高于 exe 的标签，而标签从所在目录继承；以 Low 运行的程序
    写不了 %TEMP%、建不了符号链接。目录还不存在（例如 cargo clean 之后）时，按它将继承的最近上级判断。
    """
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


def main() -> int:
    problems = integrity_problems(ROOT)
    if problems:
        print("以下构建输出目录带 Low 完整性标签，其中的程序写不了 %TEMP%、建不了符号链接（见 packaging/README.md「验证」）：", file=sys.stderr)
        for path in problems:
            path.mkdir(parents=True, exist_ok=True)
            print(f"  icacls {path} /setintegritylevel '(OI)(CI)M'", file=sys.stderr)
        print("执行上面的命令后重跑。", file=sys.stderr)
        return 2

    failed = []
    for command in COMMANDS:
        print(f"\n=== {' '.join(command)}", flush=True)
        executable = shutil.which(command[0])
        if executable is None or subprocess.run([executable, *command[1:]], cwd=ROOT).returncode != 0:
            failed.append(" ".join(command))
    print("\n=== 汇总")
    for command in COMMANDS:
        print(f"{'失败' if ' '.join(command) in failed else '通过'}  {' '.join(command)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
