#!/usr/bin/env python3
"""质量门禁：对本次改动的业务源码跑 crapper、dryer，带 --mutate 时再跑 mutator（见 docs/adr/0020、0022）。

改动集 = merge-base(HEAD, origin/main)..HEAD 的新增 / 修改 / 重命名文件，加上未提交与未跟踪的文件。
范围（源码根与排除）只在 uml-quality.json 一处声明；三个工具都是 dsh-uml-viewer 那个单一二进制的
子命令（uml-viewer crap / dry / mutate），二进制从哪儿来找看 viewer_binary()。
只依赖 Python 标准库。用法：python packaging\\quality.py [--mutate]
"""

from collections.abc import Mapping
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCE_SUFFIXES = (".ts", ".tsx", ".rs")
CRAP_THRESHOLD = "10"
DRY_THRESHOLD = "0.8"
BASE_REF = "origin/main"

# 质量工具的二进制：UML_VIEWER_BIN 优先，否则用 DSH 插件装的那一份。
VIEWER_BIN_VARIABLE = "UML_VIEWER_BIN"
DSH_HOME_VARIABLE = "DSH_HOME"
VIEWER_PLUGIN = "dsh-uml-viewer"
VIEWER_PLUGIN_RECORD = "current.json"
VIEWER_BINARY_NAME = "uml-viewer.exe" if os.name == "nt" else "uml-viewer"

# 变异工作副本要额外复制进来的路径，相对包根；client、server 都是仓库根的直接子目录，
# 所以两个包的取值相同。mutator 在 Windows 上只为每个变异体复制被运行的那个包，包外依赖
# 不在副本里，改动文件的基线测试一读就失败（见 docs/adr/0022、#102）：
# contracts/ 放画板策略与网关实测夹具；docs/release 与 server/Cargo.toml 是 changelog 守护测试
# 要读的更新说明与版本号（client/src/core/changelog.test.ts、ui/ChangelogDialog.tsx 的 ?raw import）。
MUTATION_COPIES = ("../contracts", "../docs/release", "../server/Cargo.toml")


class ViewerMissing(RuntimeError):
    """找不到可用的 uml-viewer 二进制。"""


@dataclass(frozen=True)
class Scope:
    roots: tuple[str, ...]
    excludes: tuple[str, ...]

    @staticmethod
    def load(root: Path) -> "Scope":
        tools = json.loads((root / "uml-quality.json").read_text(encoding="utf-8"))["standardTools"]
        return Scope(roots=tuple(tools["sourceRoots"]), excludes=tuple(tools.get("exclude", ())))


@dataclass(frozen=True)
class Package:
    """一个源码根所在的包（client、server）：工具以它为根运行，覆盖率报告与指标都落在包内。

    vitest 写出的 lcov 路径相对包目录，以仓库根运行时 crapper 对不上，覆盖率会变成 N/A。
    """

    root: str
    source: str
    excludes: tuple[str, ...]

    def tool_args(self) -> list[str]:
        """三个工具共用的根与范围参数，保证报告覆盖同一批代码。"""
        return ["--root", self.root, "-s", self.source, *[arg for e in self.excludes for arg in ("--exclude", e)]]

    def own(self, files: list[str]) -> list[str]:
        """属于本包的文件，换算成包内路径。"""
        prefix = self.root + "/"
        return [f.removeprefix(prefix) for f in files if f.startswith(prefix)]


def packages(scope: Scope) -> list[Package]:
    """每个源码根的上一级目录是一个包；排除规则分给它所在的包。"""
    result = []
    for source in scope.roots:
        root, _, inner = source.rpartition("/")
        prefix = root + "/"
        result.append(Package(root=root, source=inner,
                              excludes=tuple(e.removeprefix(prefix) for e in scope.excludes if e.startswith(prefix))))
    return result


def in_scope(scope: Scope, files: list[str]) -> list[str]:
    """留下源码根下的 TS / Rust 文件；排除规则交给工具按同一套规则执行。"""
    return [f for f in files if f.endswith(SOURCE_SUFFIXES) and any(f.startswith(r + "/") for r in scope.roots)]


def _git_lines(root: Path, *args: str) -> list[str]:
    run = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=root, capture_output=True, text=True,
                         encoding="utf-8", check=True)
    return [line for line in run.stdout.splitlines() if line]


def changed_files(root: Path, base: str) -> list[str]:
    """base 以来提交的、未提交的与未跟踪的文件（删除的不算），按路径排序去重。"""
    committed = _git_lines(root, "diff", "--name-only", "--diff-filter=AMR", f"{base}..HEAD")
    uncommitted = _git_lines(root, "diff", "--name-only", "--diff-filter=AMR", "HEAD")
    untracked = _git_lines(root, "ls-files", "--others", "--exclude-standard")
    return sorted(set(committed) | set(uncommitted) | set(untracked))


def viewer_binary(env: Mapping[str, str]) -> Path:
    """质量工具的二进制：UML_VIEWER_BIN 优先，否则用 DSH 插件目录里 current.json 记下的那个版本。

    一个 uml-viewer 二进制就带着 crap、mutate、dry 三个子命令，不再按工具装 venv。两处都没有时
    抛 ViewerMissing，由调用方给出可读的说明（见 docs/adr/0022）。
    """
    configured = env.get(VIEWER_BIN_VARIABLE, "").strip()
    if configured:
        binary = Path(configured)
        if binary.is_file():
            return binary
        raise ViewerMissing(f"{VIEWER_BIN_VARIABLE} 指向的 {configured} 不是文件；它应该是 uml-viewer 二进制的绝对路径")
    plugin = Path(env.get(DSH_HOME_VARIABLE) or Path.home() / ".dsh") / VIEWER_PLUGIN
    try:
        version = json.loads((plugin / VIEWER_PLUGIN_RECORD).read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError):
        version = None
    binary = plugin / str(version) / VIEWER_BINARY_NAME
    if version and binary.is_file():
        return binary
    raise ViewerMissing(
        f"找不到 uml-viewer 二进制（查过 {VIEWER_BIN_VARIABLE} 与 {plugin}）。"
        f"crap、mutate、dry 都是它的子命令：用 dsh plugin add dsh-uml-viewer 装 DSH 插件"
        f"（二进制落在 {plugin}/<版本>/），或用 {VIEWER_BIN_VARIABLE} 指定二进制绝对路径（见 docs/adr/0022）")


def tool_command(binary: Path, subcommand: str, args: list[str]) -> list[str]:
    """一个工具的完整命令行：单一二进制加子命令，取代原来三个 Python 工具的 -m 调用。"""
    return [str(binary), subcommand, *args]


def mutation_command(binary: Path, package: Package, changed: list[str]) -> list[str]:
    """mutator 的命令行：先是范围参数，再逐个 --copy（只有 mutator 有这个开关），最后是改动的文件。"""
    copies = [argument for directory in MUTATION_COPIES for argument in ("--copy", directory)]
    return tool_command(binary, "mutate", [*package.tool_args(), *copies, *changed])


def tool_help(binary: Path, subcommand: str) -> str:
    """二进制的某个子命令的 --help 文本；跑不起来时为空串。"""
    run = subprocess.run([str(binary), subcommand, "--help"], capture_output=True, text=True, encoding="utf-8",
                         errors="replace")
    return run.stdout if run.returncode == 0 else ""


def copy_supported(help_text: str) -> bool:
    """mutator 是否认得 --copy；uml-viewer 1.0.0 还没有这个开关，带 --mutate 时不能静默跳过（见 docs/adr/0022）。"""
    return "--copy" in help_text


_CRAP_ROW = re.compile(r"^(?P<name>\S+)\s+(?P<namespace>\S+)\s+\d+\s+\S+\s+N/A\s*$", re.M)


def crap_unmeasured(report: str) -> list[str]:
    """crapper 报告里没有 CRAP 分的函数（覆盖率缺失）；它们照样退出 0，门禁要算失败。"""
    return [f"{m['namespace']}/{m['name']}" for m in _CRAP_ROW.finditer(report)]


def _segments(text: str, opener: str, closer: str) -> list[str]:
    """text 里深度为 1 的 opener…closer 片段；跳过字符串字面量里的括号（快照是单行 EDN）。"""
    segments, depth, begin, in_string, escaped = [], 0, None, False, False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == opener:
            if depth == 0:
                begin = index
            depth += 1
        elif char == closer and depth:
            depth -= 1
            if depth == 0 and begin is not None:
                segments.append(text[begin:index + 1])
                begin = None
    return segments


def mutation_uncovered(edn: str, changed: set[str]) -> int:
    """一份 mutate 快照里，本次改动文件的未覆盖变异点数之和（见 docs/adr/0022）。

    Rust mutator 不再打印 Python 版的结果表，未覆盖的变异点只有快照里有：:forms 里每个 map 记着
    :file（相对包根）与 :uncovered 数量。快照目录里还留着别的文件上次运行的记录，只统计改动文件。
    """
    forms = _segments(edn[edn.find(":forms"):], "{", "}") if ":forms" in edn else []
    total = 0
    for form in forms:
        source = re.search(r':file\s+"([^"]*)"', form)
        uncovered = re.search(r":uncovered\s+(\d+)", form)
        if source and uncovered and source[1] in changed:
            total += int(uncovered[1])
    return total


def uncovered_sites(root: Path, package: Package, changed: list[str]) -> int:
    """包内 .metrics/mutate/*.edn 汇总的未覆盖变异点数；只统计本次改动的文件。"""
    directory = root / package.root / ".metrics" / "mutate"
    if not directory.is_dir():
        return 0
    return sum(mutation_uncovered(path.read_text(encoding="utf-8", errors="replace"), set(changed))
               for path in sorted(directory.glob("*.edn")))


_PAIR = re.compile(r"^DUPLICATE score=(?P<score>\S+)\n\s+(?P<left>\S.*?):(?P<ll>\d+-\d+)\n\s+(?P<right>\S.*?):(?P<rl>\d+-\d+)$", re.M)


def dry_offenders(report: str, changed: set[str]) -> list[str]:
    """dryer 文本报告里至少一边落在改动文件上的配对；两边都没动的是存量，不拦。"""
    return [f"{m['score']} {m['left']}:{m['ll']} <-> {m['right']}:{m['rl']}"
            for m in _PAIR.finditer(report) if m["left"] in changed or m["right"] in changed]


ROOT = Path(__file__).resolve().parent.parent


def _run(command: list[str]) -> subprocess.CompletedProcess:
    """在仓库根运行工具，输出照常打印，同时留一份给判定用。"""
    run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(run.stdout, end="", flush=True)
    print(run.stderr, end="", file=sys.stderr, flush=True)
    return run


def _check_package(binary: Path, package: Package, changed: list[str], mutate: bool) -> list[str]:
    """对一个包里的改动文件跑各工具，返回违规说明。工具出错（非约定退出码）同样算违规。"""
    failures = []
    crap = _run(tool_command(binary, "crap", [*package.tool_args(), "--threshold", CRAP_THRESHOLD, *changed]))
    if crap.returncode == 2:
        failures.append(f"CRAP 超过 {CRAP_THRESHOLD}：拆分函数或补测试")
    elif crap.returncode:
        failures.append(f"crapper 失败（退出码 {crap.returncode}）")
    failures += [f"没有 CRAP 分（覆盖率缺失）：{name}" for name in crap_unmeasured(crap.stdout)]
    dry = _run(tool_command(binary, "dry", [*package.tool_args(), "--threshold", DRY_THRESHOLD]))
    if dry.returncode:
        failures.append(f"dryer 失败（退出码 {dry.returncode}）")
    failures += [f"重复（相似度 >= {DRY_THRESHOLD}）：{pair}" for pair in dry_offenders(dry.stdout, set(changed))]
    if mutate:
        mutation = _run(mutation_command(binary, package, changed))
        if mutation.returncode == 3:
            failures.append("有存活的变异体：补断言杀掉，或删掉死代码")
        elif mutation.returncode:
            failures.append(f"mutator 失败（退出码 {mutation.returncode}）")
        gaps = uncovered_sites(ROOT, package, changed)
        if gaps:
            failures.append(f"{gaps} 个变异点没有测试覆盖")
    return [f"{package.root}: {failure}" for failure in failures]


def main(argv: list[str]) -> int:
    scope = Scope.load(ROOT)
    base = _git_lines(ROOT, "merge-base", "HEAD", BASE_REF)[0]
    changed = in_scope(scope, changed_files(ROOT, base))
    if not changed:
        print(f"质量门禁：自 {BASE_REF}（{base[:8]}）以来没有改动业务源码，跳过")
        return 0
    print(f"质量门禁：自 {BASE_REF}（{base[:8]}）以来改动 {len(changed)} 个业务源码文件", flush=True)
    try:
        binary = viewer_binary(os.environ)
    except ViewerMissing as error:
        print(f"质量门禁失败：{error}", file=sys.stderr)
        return 1
    mutate = "--mutate" in argv
    if mutate and not copy_supported(tool_help(binary, "mutate")):
        print(f"质量门禁失败：{binary} 的 mutator 不支持 --copy，变异副本里没有仓库的 contracts/。"
              "请换用带 --copy 的 dsh-uml-viewer 构建（见 docs/adr/0022、#102）", file=sys.stderr)
        return 1
    failures = [failure for package in packages(scope) if package.own(changed)
                for failure in _check_package(binary, package, package.own(changed), mutate=mutate)]
    for failure in failures:
        print(f"质量门禁失败：{failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
