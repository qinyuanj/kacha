#!/usr/bin/env python3
"""打包共用的门禁：更新说明与版本线。两个构建入口都过这里，规则只写一遍（见文档 docs/adr/0024）。

- **更新说明**是产品级文档，也是界面「更新内容」的唯一来源：当前版本要有自己的一节，且该节
  「新增 / 改进 / 修复」下至少一条条目；一级标题只放版本号。
- **版本线只有一条**：服务端清单与桌面配置必须同号。产品不是两个，桌面客户端接在 1.4.x 之后。

失败时抛 SystemExit，信息是给维护者看的中文原因：构建入口不捕获它，进程以非零退出码结束，
也不会有任何构建命令被跑过。只依赖 Python 标准库。
"""

from pathlib import Path
import re
import tomllib


CHANGELOG = Path("docs") / "release" / "web-changelog.md"
"""更新说明，相对仓库根；界面「更新内容」的唯一来源。"""
CHANGELOG_GROUPS = ("新增", "改进", "修复")
"""更新说明的二级标题只认这三个分组；其余分组的条目不算数。"""

SERVER_MANIFEST = Path("server") / "Cargo.toml"
"""服务端清单：web 顶栏与 `/api/config` 报的就是这里的版本。"""

DESKTOP_CONFIG = Path("mygo.config.ts")
"""桌面配置：MyGo 从这里取版本，写进可执行文件的版本资源与构建记录。"""


def server_version(root: Path) -> str:
    """服务端清单声明的版本；缺字段时以中文信息退出。"""
    with (root / SERVER_MANIFEST).open("rb") as manifest_file:
        manifest = tomllib.load(manifest_file)
    version = manifest.get("package", {}).get("version")
    if not version:
        raise SystemExit(f"服务端清单 {SERVER_MANIFEST.as_posix()} 里没有 [package] 的 version")
    return version


def parse_config_version(text: str) -> str | None:
    """从 mygo.config.ts 里取 version：配置是普通对象，版本只在那一处定义。"""
    match = re.search(r"""^\s*version:\s*["']([^"']+)["']""", text, re.MULTILINE)
    return match.group(1) if match else None


def desktop_version(root: Path) -> str:
    """桌面配置声明的版本；缺这一行时以中文信息退出。"""
    version = parse_config_version((root / DESKTOP_CONFIG).read_text(encoding="utf-8"))
    if version is None:
        raise SystemExit(f"桌面配置 {DESKTOP_CONFIG.as_posix()} 里没有 version")
    return version


def check_version_line(root: Path) -> str:
    """两张清单同号时返回这个版本号；不同号时以中文信息退出，并说清两边各是什么。"""
    server, desktop = server_version(root), desktop_version(root)
    if server != desktop:
        raise SystemExit(
            f"版本号不一致：服务端清单 {SERVER_MANIFEST.as_posix()} 是 {server}，"
            f"桌面配置 {DESKTOP_CONFIG.as_posix()} 是 {desktop}；"
            f"产品只有一条版本线，两张清单必须同号"
        )
    return server


def check_release_notes(root: Path, version: str) -> None:
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
