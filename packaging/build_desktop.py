#!/usr/bin/env python3
"""在开发机构建 Kacha Windows 桌面客户端；只依赖 Python 标准库。

从仓库根运行，命令按 PATH 与 PATHEXT 解析，失败即以中文信息退出。
产物在 build/windows-amd64/：Kacha.exe、版本化反馈中继、build-info.json（本次构建记录的 MyGo / Go / WebView2 版本）。debug 输出未带版本的 feedbackrelay.exe。
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from release_gate import check_release_notes, desktop_version, relay_asset_name

MYGO_VERSION = "0.9.0"
"""固定的 MyGo 版本：go.mod 的 tool 指令也钉在同一版本，升级要单独验证（ADR 0023）。"""

PLATFORM = "windows/amd64"
"""本切片的构建目标；macOS 与 Linux 不在第一竖切内。"""

GOOS, GOARCH = PLATFORM.split("/")
"""反馈中继与桌面客户端使用同一目标平台。"""

OUT = Path("build") / "windows-amd64"
"""MyGo 的产物目录，相对仓库根（mygo.config.ts 的 out 是 build）。"""

WEBVIEW2_KEY = r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
"""WebView2 Runtime 的注册表位置；MyGo 也从这些渠道找运行时。"""


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    # 按 PATH 与 PATHEXT 解析命令：Windows 直接启动进程只会补 .exe，找不到 npm.cmd 这类脚本。
    executable = shutil.which(command[0])
    if executable is None:
        raise SystemExit(f"找不到命令：{command[0]}")
    subprocess.run([executable, *command[1:]], cwd=cwd, check=True, env=env)


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
    parser.add_argument("--debug", action="store_true", help="验证用 debug 构建，输出到 build/debug/windows-amd64")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    # 产品版本只来自桌面配置；门禁失败时不运行构建。
    version = desktop_version(root)
    check_release_notes(root, version)

    if not args.skip_install:
        run(["npm", "ci"], root / "client")

    # CLI 钉在 go.mod 的 tool 指令上；buildCommand（前端构建）由 mygo build 自己跑。
    # debug 只验证可执行程序；正式构建必须让 MyGo 生成当前用户 NSIS 安装器。
    output = Path("build") / "debug" / "windows-amd64" if args.debug else OUT
    debug_args = ["-debug", "-o", "build/debug"] if args.debug else []
    installer_args = ["-skip-installer"] if args.debug else []
    run(["go", "tool", "mygo", "build", "-platform", PLATFORM, *installer_args, *debug_args], root)

    exe = root / output / "Kacha.exe"
    if not exe.exists():
        raise SystemExit(f"构建没有产出 {exe}")
    installer = root / output / f"kacha-setup-{version}-amd64.exe"
    if not args.debug and not installer.exists():
        raise SystemExit(f"正式构建没有产出当前用户安装器 {installer}")

    # 反馈中继是独立单二进制：只用环境变量在运行时配置，Gitea token 不参与编译。
    # 发布中继直接编译成版本化资产名；debug 仍用本地固定名，便于开发脚本引用。
    relay = output / (relay_asset_name(version) if not args.debug else "feedbackrelay.exe")
    relay_env = dict(os.environ, GOOS=GOOS, GOARCH=GOARCH, CGO_ENABLED="0")
    run(["go", "build", "-o", relay.as_posix(), "./desktop/cmd/feedbackrelay"], root, env=relay_env)
    if not (root / relay).exists():
        raise SystemExit(f"构建没有产出反馈中继 {root / relay}")

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
        "profile": "debug" if args.debug else "release",
        "exe": (output / "Kacha.exe").as_posix(),
        "relay": relay.as_posix(),
        "relay_asset": relay.as_posix() if not args.debug else None,
        "installer": installer.relative_to(root).as_posix() if not args.debug else None,
    }
    (root / output / "build-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"客户端：{exe}")
    print(f"中继：{root / relay}")
    print(f"记录：MyGo {info['mygo']} / {info['go']} / WebView2 {info['webview2']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
