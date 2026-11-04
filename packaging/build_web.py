#!/usr/bin/env python3
"""在开发机收集 Kacha Web 的 release 部署目录；只依赖 Python 标准库。"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess


def run(command: list[str], cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 kacha-server 与前端静态文件到 release/kacha-web")
    parser.add_argument("--skip-npm-ci", action="store_true", help="沿用已按 package-lock.json 安装的依赖")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    client = root / "client"
    server = root / "server"
    npm = "npm.cmd" if os.name == "nt" else "npm"

    if not args.skip_npm_ci:
        run([npm, "ci"], client)
    run([npm, "run", "build"], client)
    run(["cargo", "build", "--release"], server)

    output = root / "release" / "kacha-web"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    binary = "kacha-server.exe" if os.name == "nt" else "kacha-server"
    shutil.copy2(server / "target" / "release" / binary, output / binary)
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
