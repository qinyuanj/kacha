#!/usr/bin/env python3
"""桌面打包门禁：mygo.config.ts 是唯一产品版本源，当前版本必须有更新说明。"""

from pathlib import Path
import re

CHANGELOG = Path("docs") / "release" / "changelog.md"
CHANGELOG_GROUPS = ("新增", "改进", "修复")
DESKTOP_CONFIG = Path("mygo.config.ts")


def parse_config_version(text: str) -> str | None:
    """从普通对象配置里取唯一的 version 声明。"""
    match = re.search(r"""^\s*version:\s*["']([^"']+)["']""", text, re.MULTILINE)
    return match.group(1) if match else None


def desktop_version(root: Path) -> str:
    """桌面配置声明的产品版本；缺版本时在构建前失败。"""
    version = parse_config_version((root / DESKTOP_CONFIG).read_text(encoding="utf-8"))
    if version is None:
        raise SystemExit(f"桌面配置 {DESKTOP_CONFIG.as_posix()} 里没有 version")
    return version


def check_release_notes(root: Path, version: str) -> None:
    """当前版本节的「新增 / 改进 / 修复」下至少有一条，不把 HTML 注释算内容。"""
    text = (root / CHANGELOG).read_text(encoding="utf-8")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
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
