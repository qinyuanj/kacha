#!/usr/bin/env python3
"""在开发机收集 Kacha Web 的 release 部署目录；只依赖 Python 标准库。"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tomllib


SERVER_BINARY = "kacha-server.exe" if os.name == "nt" else "kacha-server"
"""服务端可执行文件名：构建产物与部署目录里都用它；压测脚本导入同一定义。"""


def run(command: list[str], cwd: Path) -> None:
    # 按 PATH 与 PATHEXT 解析命令：Windows 直接启动进程只会补 .exe，找不到 npm.cmd 这类脚本。
    executable = shutil.which(command[0])
    if executable is None:
        raise SystemExit(f"找不到命令：{command[0]}")
    subprocess.run([executable, *command[1:]], cwd=cwd, check=True)


CHANGELOG = Path("docs") / "release" / "web-changelog.md"
"""网页版更新说明，相对仓库根；界面「更新内容」的唯一来源。"""
CHANGELOG_GROUPS = ("新增", "改进", "修复")


def server_version(root: Path) -> str:
    with (root / "server" / "Cargo.toml").open("rb") as f:
        return tomllib.load(f)["package"]["version"]


def check_changelog(root: Path, version: str) -> None:
    """更新说明缺少当前版本一节、或该节「新增 / 改进 / 修复」下没有条目时，以中文信息退出。"""
    text = (root / CHANGELOG).read_text(encoding="utf-8")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)  # HTML 注释是写作约定，不算内容
    section: list[str] | None = None
    for line in text.splitlines():
        if line.startswith("# "):
            if section is not None:
                break
            if line[2:].strip() == version:
                section = []
        elif section is not None:
            section.append(line)
    where = f"更新说明 {CHANGELOG.as_posix()}"
    if section is None:
        raise SystemExit(f"{where} 缺少当前版本 {version} 的一节")
    group = None
    items = 0
    for line in section:
        if line.startswith("## "):
            group = line[3:].strip()
        elif group in CHANGELOG_GROUPS and line.startswith("- ") and line[2:].strip():
            items += 1
    if items == 0:
        raise SystemExit(f"{where} 中 {version} 一节没有条目：至少在「新增 / 改进 / 修复」之一下写一条")


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 kacha-server 与前端静态文件到 release/kacha-web")
    parser.add_argument("--skip-npm-ci", action="store_true", help="沿用已按 package-lock.json 安装的依赖")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    client = root / "client"
    server = root / "server"
    check_changelog(root, server_version(root))

    if not args.skip_npm_ci:
        run(["npm", "ci"], client)
    run(["npm", "run", "build"], client)
    run(["cargo", "build", "--release"], server)

    output = root / "release" / "kacha-web"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shutil.copy2(server / "target" / "release" / SERVER_BINARY, output / SERVER_BINARY)
    shutil.copytree(client / "dist", output / "static")

    index = (output / "static" / "index.html").read_text(encoding="utf-8")
    absolute = re.findall(r"(?:src|href)=[\"'](/(?!/)[^\"']*)", index)
    if absolute:
        raise SystemExit(f"静态资源必须使用相对路径，发现：{absolute}")
    lines = []
    for path in sorted(p for p in output.rglob("*") if p.is_file() and p.name != "SHA256SUMS"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(output).as_posix()}")
    (output / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"部署目录：{output}")
    print("目标机只需该目录；启动时显式传入 --data-root、--gateway-url 与 --static-dir。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
