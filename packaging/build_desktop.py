#!/usr/bin/env python3
"""在开发机构建 Kacha Windows 桌面客户端；只依赖 Python 标准库。

与 build_web.py 同一套约定：从仓库根运行，命令按 PATH 与 PATHEXT 解析，失败即以中文信息退出。
产物在 build/windows-amd64/：Kacha.exe、build-info.json（本次构建记录的 MyGo / Go / WebView2 版本）。
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

# parse_config_version 是给既有调用点的同名转发（规则在 release_gate 里，这里不重写一遍）。
from release_gate import check_release_notes, check_version_line, parse_config_version

MYGO_VERSION = "0.9.0"
"""固定的 MyGo 版本：go.mod 的 tool 指令也钉在同一版本，升级要单独验证（ADR 0023）。"""

PLATFORM = "windows/amd64"
"""本切片的构建目标；macOS 与 Linux 不在第一竖切内。"""

OUT = Path("build") / "windows-amd64"
"""MyGo 的产物目录，相对仓库根（mygo.config.ts 的 out 是 build）。"""

WEBVIEW2_KEY = r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
"""WebView2 Runtime 的注册表位置；MyGo 也从这些渠道找运行时。"""


def run(command: list[str], cwd: Path) -> None:
    # 按 PATH 与 PATHEXT 解析命令：Windows 直接启动进程只会补 .exe，找不到 npm.cmd 这类脚本。
    executable = shutil.which(command[0])
    if executable is None:
        raise SystemExit(f"找不到命令：{command[0]}")
    subprocess.run([executable, *command[1:]], cwd=cwd, check=True)


def capture(command: list[str], cwd: Path) -> str:
    """跑一条命令并取它的标准输出；命令不存在或失败时返回空串（版本记录不该让构建失败）。"""
    executable = shutil.which(command[0])
    if executable is None:
        return ""
    try:
        done = subprocess.run([executable, *command[1:]], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return done.stdout if done.returncode == 0 else ""


def parse_mygo_version(output: str) -> str | None:
    """mygo version 的输出形如 "mygo 0.9.0"。"""
    match = re.search(r"mygo\s+(\d+\.\d+\.\d+)", output)
    return match.group(1) if match else None


def parse_go_version(output: str) -> str | None:
    """go version 的输出形如 "go version go1.27.3 windows/amd64"。"""
    match = re.search(r"\b(go\d+\.\d+\.\d+)", output)
    return match.group(1) if match else None


def parse_webview2_version(output: str) -> str | None:
    """reg query 的输出里，pv 那一行是 WebView2 Runtime 的版本。"""
    match = re.search(r"\bpv\s+REG_SZ\s+(\S+)", output)
    return match.group(1) if match else None


def webview2_version() -> str | None:
    """Windows 上读注册表；其他平台没有 WebView2。"""
    if os.name != "nt":
        return None
    return parse_webview2_version(capture(["reg", "query", WEBVIEW2_KEY, "/v", "pv"], Path.cwd()))


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 Kacha Windows 桌面客户端到 build/windows-amd64")
    parser.add_argument("--skip-install", action="store_true", help="沿用已按 package-lock.json 安装的前端依赖")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    # 门禁：两张清单同号、更新说明有当前版本一节；不通过就不跑任何构建。
    version = check_version_line(root)
    check_release_notes(root, version)

    if not args.skip_install:
        run(["npm", "ci"], root / "client")

    # CLI 钉在 go.mod 的 tool 指令上；buildCommand（前端构建）由 mygo build 自己跑。
    run(["go", "tool", "mygo", "build", "-platform", PLATFORM, "-skip-installer"], root)

    exe = root / OUT / "Kacha.exe"
    if not exe.exists():
        raise SystemExit(f"构建没有产出 {exe}")

    mygo = parse_mygo_version(capture(["go", "tool", "mygo", "version"], root))
    if mygo is not None and mygo != MYGO_VERSION:
        raise SystemExit(f"CLI 版本是 {mygo}，本切片固定在 {MYGO_VERSION}：检查 go.mod 的 tool 指令")
    info = {
        "app": "Kacha",
        "version": version,
        "platform": PLATFORM,
        "mygo": mygo,
        "go": parse_go_version(capture(["go", "version"], root)),
        "webview2": webview2_version(),
        "exe": (OUT / "Kacha.exe").as_posix(),
    }
    (root / OUT / "build-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"客户端：{exe}")
    print(f"记录：MyGo {info['mygo']} / {info['go']} / WebView2 {info['webview2']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
