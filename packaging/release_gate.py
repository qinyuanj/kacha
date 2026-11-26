#!/usr/bin/env python3
"""桌面打包门禁：mygo.config.ts 是唯一产品版本源，当前版本必须有更新说明，历史说明不参与取版本。"""

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


def changelog_section(text: str, version: str) -> list[str] | None:
    """changelog.md 里「# <版本>」那一节的行（不含标题，到下一个一级标题前）；没有这一节时 None。

    HTML 注释整段先去掉：还没定稿的内容不算已经发布。
    """
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
    return section


def release_notes_section(root: Path, version: str) -> str:
    """发布说明：唯一来源 docs/release/changelog.md 里当前版本那一节（含一级标题，ADR 0024）。

    发布脚本与安装器签名都从这里取说明，不另立 release-notes-<版本>.md 之类的第二份文件：
    两份说明迟早会对不上，而用户只该看到一份。
    """
    text = (root / CHANGELOG).read_text(encoding="utf-8")
    section = changelog_section(text, version)
    if section is None:
        raise SystemExit(f"更新说明 {CHANGELOG.as_posix()} 缺少当前版本 {version} 的一节")
    body = "\n".join(section).strip("\n")
    return f"# {version}\n\n{body}\n" if body else f"# {version}\n"


def check_release_notes(root: Path, version: str) -> None:
    """当前版本节的「新增 / 改进 / 修复」下至少有一条，不把 HTML 注释算内容。"""
    text = (root / CHANGELOG).read_text(encoding="utf-8")
    section = changelog_section(text, version)
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


def validate_release_assets(manifest: dict[str, object], expected_version: str) -> None:
    """发布前核对唯一版本、目标平台、包 URL、发布者签名与更新描述一致。

    只检查可公开核对的清单字段；私钥不参与校验，也不能从哈希推导签名。
    """
    version = manifest.get("version")
    if version != expected_version or not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit(f"发布资产版本必须等于 mygo.config.ts 的 {expected_version}，当前是 {version!r}")
    if manifest.get("platform") != "windows-amd64":
        raise SystemExit(f"发布资产的平台必须是 windows/amd64，当前是 {manifest.get('platform')!r}")
    url = manifest.get("url")
    if not isinstance(url, str) or f"/v{version}/" not in url or "://" not in url:
        raise SystemExit(f"发布包 URL 必须指向 v{version} 的 Gitea Release 附件")
    signature = manifest.get("signature")
    if not isinstance(signature, str) or not signature.strip():
        raise SystemExit("发布资产缺少发布者签名：哈希不能替代更新签名")
    notes = manifest.get("notes")
    if not isinstance(notes, str) or not re.search(rf"^#\s+{re.escape(version)}\s*$", notes, re.MULTILINE):
        raise SystemExit(f"更新描述缺少当前版本 {version} 的一级标题")
