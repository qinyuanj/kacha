#!/usr/bin/env python3
"""桌面验证：预检、打包脚本单测、前端单测/类型/死代码、Go 测试、debug 构建与前端质量门禁。

不运行 e2e。--quality 表示合入集成分支前的发版门禁（CRAP 与重复检查，不含变异测试）；
--base 显式指定质量比较基线。
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import release_gate

ROOT = Path(__file__).resolve().parent.parent
BUILD_OUTPUTS = (Path("build"), Path("client") / "target")
CLIENT = Path("client")
LOCKFILE = CLIENT / "package-lock.json"
INSTALL_RECORD = CLIENT / "node_modules" / ".package-lock.json"
INSTALL_HINT = "npm --prefix client ci"
REPORTED_PACKAGES = 3
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
    parser.add_argument("--quality", action="store_true",
                        help="发版门禁：CRAP 与重复检查（与默认验证同一组步骤，不跑变异测试）")
    parser.add_argument("--base")
    args = parser.parse_args(argv)
    # 2026-11-20 决定不做变异测试，--quality 不再追加 --mutate：本机 commit limit 只有 23,060 MB，
    # 变异工作副本会把整机拖崩（见 docs/adr/0020）。参数保留，旧习惯不会被当成未知参数拒绝。
    quality = list(QUALITY)
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


def _locked_packages(path: Path) -> dict[str, dict]:
    return json.loads(path.read_text(encoding="utf-8")).get("packages") or {}


def dependency_problems(root: Path) -> list[str]:
    """返回前端依赖与 lockfile 不一致的原因；为空表示可以开始验证。

    只读两个 lockfile，不调用 npm，通常几毫秒。optional 条目按平台选择性安装，
    缺失属于正常，不作为问题。缺少安装记录时一律判定为未安装。
    """
    lockfile = root / LOCKFILE
    if not lockfile.is_file():
        return []
    record = root / INSTALL_RECORD
    if not record.is_file():
        return [f"{CLIENT.as_posix()}/node_modules 未按 lockfile 安装"]
    try:
        locked = _locked_packages(lockfile)
        installed = _locked_packages(record)
    except (OSError, ValueError):
        return [f"{INSTALL_RECORD.as_posix()} 无法解析，安装记录已损坏"]
    problems = []
    for relative, entry in locked.items():
        if not relative or entry.get("optional"):
            continue
        name = relative.removeprefix("node_modules/")
        found = installed.get(relative)
        if found is None or not (root / CLIENT / relative / "package.json").is_file():
            problems.append(f"缺少 {name}")
        elif entry.get("version") and found.get("version") and entry["version"] != found["version"]:
            problems.append(f"{name} 是 {found['version']}，lockfile 要 {entry['version']}")
    return problems


def dependencies_preflight(root: Path) -> int:
    """依赖没装全时只报原因与修复命令：继续跑 npm 会把环境问题报成源码错误。"""
    problems = dependency_problems(root)
    if not problems:
        return 0
    shown = "、".join(problems[:REPORTED_PACKAGES])
    more = f" 等 {len(problems)} 个包" if len(problems) > REPORTED_PACKAGES else ""
    print(
        f"前端依赖与 {LOCKFILE.as_posix()} 不一致（{shown}{more}），已跳过 npm 测试、typecheck、knip 与构建：",
        file=sys.stderr,
    )
    print(f"  {INSTALL_HINT}（在仓库根执行；见 packaging/README.md「验证前的依赖准备」）", file=sys.stderr)
    return 2


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


def documentation_problems(root: Path) -> list[str]:
    """#211：唯一版本、更新说明、ADR、词表与 README 不能互相脱节。"""
    problems: list[str] = []
    config = root / "mygo.config.ts"
    if not config.is_file():
        return ["缺少 mygo.config.ts"]
    try:
        version = release_gate.desktop_version(root)
    except (OSError, SystemExit) as error:
        return [f"mygo.config.ts 无法读取唯一版本：{error}"]

    changelog = root / release_gate.CHANGELOG
    text = ""
    if not changelog.is_file():
        problems.append(f"缺少 {release_gate.CHANGELOG.as_posix()}")
    else:
        try:
            text = changelog.read_text(encoding="utf-8")
        except OSError as error:
            problems.append(f"{release_gate.CHANGELOG.as_posix()} 无法读取：{error}")
    visible = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    headings = re.findall(r"^# (\S+)\s*$", visible, flags=re.MULTILINE)
    current = headings[0] if headings else "无"
    if current != version:
        problems.append(f"{release_gate.CHANGELOG.as_posix()} 当前版本应为 {version}，实际是 {current}")
    section = release_gate.changelog_section(text, version) if text else None
    if section is None:
        problems.append(f"{release_gate.CHANGELOG.as_posix()} 缺少当前版本 {version} 的一节")
    else:
        group = None
        items = 0
        for line in section:
            if line.startswith("## "):
                group = line[3:].strip()
            elif group in release_gate.CHANGELOG_GROUPS and line.startswith("- ") and line[2:].strip():
                items += 1
        if items == 0:
            problems.append(f"{release_gate.CHANGELOG.as_posix()} 中 {version} 一节没有可显示条目")
        if "反馈" not in "\n".join(section):
            problems.append(f"{release_gate.CHANGELOG.as_posix()} 中 {version} 一节没有用户可见的反馈能力")

    adr_files = sorted((root / "docs" / "adr").glob("0027-*.md"))
    if len(adr_files) != 1:
        problems.append("缺少 ADR 0027：docs/adr/0027-*.md")
    else:
        adr = adr_files[0].read_text(encoding="utf-8")
        for phrase, label in (
            ("反馈中继", "反馈中继"),
            ("可选", "可选联网能力"),
            ("离线", "核心画板离线可用"),
            ("远端应用服务", "不新增远端应用服务依赖"),
        ):
            if phrase not in adr:
                problems.append(f"ADR 0027 未说明{label}")

    glossary = root / "GLOSSARY.md"
    if not glossary.is_file():
        problems.append("缺少 GLOSSARY.md")
    else:
        glossary_text = glossary.read_text(encoding="utf-8")
        for term in ("反馈", "反馈中继"):
            if re.search(rf"\*\*{term}\*\*[\s\S]*?_Avoid_[:：]", glossary_text) is None:
                problems.append(f"GLOSSARY.md 缺少「{term}」及避免使用的近义词")

    readme = root / "README.md"
    if not readme.is_file():
        problems.append("缺少 README.md")
    else:
        readme_text = readme.read_text(encoding="utf-8")
        if "## 反馈" not in readme_text or "诊断包" not in readme_text:
            problems.append("README.md 缺少反馈入口或诊断包使用说明")
    return problems


def documentation_preflight(root: Path) -> int:
    """文档门禁失败时打印全部原因，允许一次修齐。"""
    problems = documentation_problems(root)
    if not problems:
        return 0
    print("文档与版本门禁失败：", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    selected = commands(argv)
    code = preflight(ROOT) or dependencies_preflight(ROOT) or documentation_preflight(ROOT)
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
