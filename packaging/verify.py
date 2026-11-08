#!/usr/bin/env python3
"""提交前的全套验证：预检构建输出目录，再依次跑打包脚本单测、前端单测、类型检查、e2e 与服务端测试。

只依赖 Python 标准库。每条命令都跑完再汇总（cargo 带 --no-fail-fast），任一失败即以非 0 退出。
e2e 很慢，只在集成分支（main、integration/*）上跑；其他分支跳过，--e2e 强制跑（须经用户授权）。
用法：python packaging\\verify.py [--preflight] [--e2e]
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys

from install_quality_tools import install_problems
from quality import tools_home

ROOT = Path(__file__).resolve().parent.parent

# 编译和复制出来的程序放在这里，文件的完整性标签从目录继承。
# client/target 是质量工具在前端包里的覆盖率与变异 worker 目录（服务端的落在 server/target），
# .uml-viewer 是质量工具的安装与 venv（见 packaging/quality.py）。
BUILD_OUTPUTS = (Path("server") / "target", Path("release"), Path("client") / "target", Path(".uml-viewer"))

E2E = ["npm", "--prefix", "client", "run", "test:e2e", "--", "--workers=4"]

QUALITY = [sys.executable, "packaging/quality.py"]

COMMANDS = (
    [sys.executable, "-m", "unittest", "discover", "-s", "packaging/tests"],
    ["npm", "--prefix", "client", "test"],
    ["npm", "--prefix", "client", "run", "typecheck"],
    ["npm", "--prefix", "client", "run", "lint:dead"],
    E2E,
    ["cargo", "test", "--manifest-path", "server/Cargo.toml", "--no-fail-fast"],
    QUALITY,
)


def commands(argv: list[str]) -> list[list[str]]:
    """--quality 时质量门禁连变异测试一起跑（合入集成分支前必须跑，见 docs/adr/0020）。"""
    return [[*command, "--mutate"] if command is QUALITY and "--quality" in argv else command for command in COMMANDS]


def runs_e2e(branch: str, argv: list[str]) -> bool:
    """集成分支（main、integration/*）跑 e2e；其他分支与分离 HEAD 只在带 --e2e 时跑。"""
    return "--e2e" in argv or branch == "main" or branch.startswith("integration/")


def current_branch(root: Path) -> str:
    """当前分支名；分离 HEAD 时为 "HEAD"，不在 git 仓库里时为空串。"""
    run = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root, capture_output=True, text=True, errors="replace")
    return run.stdout.strip() if run.returncode == 0 else ""


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


def preflight(root: Path) -> int:
    """预检构建输出目录的完整性标签：通过为 0；有问题时打印修复命令并返回 2。"""
    problems = integrity_problems(root)
    if not problems:
        return 0
    print("以下构建输出目录带 Low 完整性标签，其中的程序写不了 %TEMP%、建不了符号链接、编译报 cl D8050（见 packaging/README.md「验证」）：", file=sys.stderr)
    for path in problems:
        path.mkdir(parents=True, exist_ok=True)
        print(f"  icacls {path} /setintegritylevel '(OI)(CI)M'", file=sys.stderr)
    print("执行上面的命令后重跑。", file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    """用法：verify.py [--preflight] [--e2e]；--preflight 只做预检，不跑测试（新建 worktree 或 clone 后先跑一次）。"""
    tools = install_problems(tools_home(ROOT))
    for problem in tools:
        print(problem, file=sys.stderr)
    code = preflight(ROOT) or (2 if tools else 0)
    if code or "--preflight" in argv:
        return code

    branch = current_branch(ROOT)
    skipped = [] if runs_e2e(branch, argv) else [" ".join(E2E)]
    failed = []
    selected = commands(argv)
    for command in selected:
        line = " ".join(command)
        if line in skipped:
            print(f"\n=== 跳过 e2e：当前分支 {branch or '（未知）'} 不是集成分支（main、integration/*），经用户授权可加 --e2e 强制跑", flush=True)
            continue
        print(f"\n=== {line}", flush=True)
        executable = shutil.which(command[0])
        if executable is None or subprocess.run([executable, *command[1:]], cwd=ROOT).returncode != 0:
            failed.append(line)
    print("\n=== 汇总")
    for command in selected:
        line = " ".join(command)
        print(f"{'跳过' if line in skipped else '失败' if line in failed else '通过'}  {line}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
