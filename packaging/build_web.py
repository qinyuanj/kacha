#!/usr/bin/env python3
"""在开发机收集 Kacha Web 的 release 部署目录；只依赖 Python 标准库。"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess


SERVER_BINARY = "kacha-server.exe" if os.name == "nt" else "kacha-server"
"""服务端可执行文件名：构建产物与部署目录里都用它；压测脚本导入同一定义。"""


def run(command: list[str], cwd: Path) -> None:
    # 按 PATH 与 PATHEXT 解析命令：Windows 直接启动进程只会补 .exe，找不到 npm.cmd 这类脚本。
    executable = shutil.which(command[0])
    if executable is None:
        raise SystemExit(f"找不到命令：{command[0]}")
    subprocess.run([executable, *command[1:]], cwd=cwd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 kacha-server 与前端静态文件到 release/kacha-web")
    parser.add_argument("--skip-npm-ci", action="store_true", help="沿用已按 package-lock.json 安装的依赖")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    client = root / "client"
    server = root / "server"

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
