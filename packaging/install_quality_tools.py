#!/usr/bin/env python3
"""安装质量门禁用的 uml-viewer、crapper、mutator、dryer，固定在 PINS 的 commit（见 docs/adr/0020）。

装进主 checkout 的 .uml-viewer/，所有 worktree 共用（packaging/quality.py 的 tools_home）。
升级：改 PINS 后重跑本脚本。前置：Rust 1.99.1 MSVC、git、Python 3.12+、Herdr >= 0.9.3（uml-viewer 安装器强制检查）。
用法：python packaging\\install_quality_tools.py
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from quality import tools_home

PINS = {
    "uml-viewer": "a618f552d5db994675489c6286a4541b75d32678",
    "crapper": "2006e8d8aad898c967e75226206d1bfd6615c283",
    "mutator": "84113c71304344f7fe43031cfcd3a2393e2703fd",
    "dryer": "af411b6f69cbee7cca2fd5e69695728c7c83eb6f",
}

REINSTALL = "python packaging\\install_quality_tools.py"


def install_problems(home: Path) -> list[str]:
    """home 下的安装与 PINS 不符之处；空表示可用。"""
    record = home / ".uml-viewer" / "install.json"
    if not record.is_file():
        return [f"质量工具未安装（{record} 不存在），请运行 {REINSTALL}"]
    installed = json.loads(record.read_text(encoding="utf-8")).get("repositories", {})
    return [f"{tool} 装的是 {installed.get(tool, {}).get('commit', '（缺失）')}，应为 {commit}，请运行 {REINSTALL}"
            for tool, commit in PINS.items() if installed.get(tool, {}).get("commit") != commit]


def ref_variable(tool: str) -> str:
    return ("UML_VIEWER" if tool == "uml-viewer" else tool.upper()) + "_REF"


def main() -> int:
    home = tools_home(Path(__file__).resolve().parent.parent)
    env = {**os.environ, **{ref_variable(tool): commit for tool, commit in PINS.items()}}
    url = f"https://raw.githubusercontent.com/qinyuanj/uml-viewer/{PINS['uml-viewer']}/scripts/get-uml-viewer.cmd"
    with tempfile.TemporaryDirectory() as tmp:
        entry = Path(tmp) / "get-uml-viewer.cmd"
        subprocess.run([shutil.which("curl.exe") or "curl", "-fsSL", "-o", str(entry), url], check=True)
        code = subprocess.run(["cmd", "/c", str(entry), "--install-only"], cwd=home, env=env).returncode
    if code:
        return code
    problems = install_problems(home)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
