#!/usr/bin/env python3
"""质量门禁：对本次改动的业务源码跑 crapper、dryer，带 --mutate 时再跑 mutator（见 docs/adr/0020）。

改动集 = merge-base(HEAD, origin/main)..HEAD 的新增 / 修改 / 重命名文件，加上未提交与未跟踪的文件。
范围（源码根与排除）只在 uml-quality.json 一处声明；工具从共享安装（packaging/install_quality_tools.py）调用。
只依赖 Python 标准库。用法：python packaging\\quality.py [--mutate]
"""

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


def tools_home(root: Path) -> Path:
    """装着 .uml-viewer/ 的 checkout：当前 checkout 自己装了就用自己的，否则用主 checkout 的（worktree 共用）。"""
    if (root / ".uml-viewer").is_dir():
        return root
    common = _git_lines(root, "rev-parse", "--path-format=absolute", "--git-common-dir")[0]
    return Path(common).parent


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


_CRAP_ROW = re.compile(r"^(?P<name>\S+)\s+(?P<namespace>\S+)\s+\d+\s+\S+\s+N/A\s*$", re.M)


def crap_unmeasured(report: str) -> list[str]:
    """crapper 报告里没有 CRAP 分的函数（覆盖率缺失）；它们照样退出 0，门禁要算失败。"""
    return [f"{m['namespace']}/{m['name']}" for m in _CRAP_ROW.finditer(report)]


_TOTAL = re.compile(r"^Total\s+(?P<killed>\d+)\s+(?P<survived>\d+)\s+(?P<uncovered>\d+)\s+(?P<sites>\d+)\s", re.M)


def mutation_gaps(report: str) -> int:
    """mutator 结果表 Total 行里未覆盖的变异点总数；mutator 对它们照样退出 0，门禁要另算。"""
    return sum(int(m["uncovered"]) for m in _TOTAL.finditer(report))


_PAIR = re.compile(r"^DUPLICATE score=(?P<score>\S+)\n\s+(?P<left>\S.*?):(?P<ll>\d+-\d+)\n\s+(?P<right>\S.*?):(?P<rl>\d+-\d+)$", re.M)


def dry_offenders(report: str, changed: set[str]) -> list[str]:
    """dryer 文本报告里至少一边落在改动文件上的配对；两边都没动的是存量，不拦。"""
    return [f"{m['score']} {m['left']}:{m['ll']} <-> {m['right']}:{m['rl']}"
            for m in _PAIR.finditer(report) if m["left"] in changed or m["right"] in changed]


ROOT = Path(__file__).resolve().parent.parent


def _tool(home: Path, name: str) -> list[str]:
    python = home / ".uml-viewer" / name / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        raise FileNotFoundError(f"{name} 未安装（{python}），请运行 python packaging\\install_quality_tools.py")
    return [str(python), "-m", name]


def _run(command: list[str]) -> subprocess.CompletedProcess:
    """在仓库根运行工具，输出照常打印，同时留一份给判定用。"""
    run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(run.stdout, end="", flush=True)
    print(run.stderr, end="", file=sys.stderr, flush=True)
    return run


def _check_package(package: Package, home: Path, changed: list[str], mutate: bool) -> list[str]:
    """对一个包里的改动文件跑各工具，返回违规说明。工具出错（非约定退出码）同样算违规。"""
    failures = []
    crap = _run([*_tool(home, "crapper"), *package.tool_args(), "--threshold", CRAP_THRESHOLD, *changed])
    if crap.returncode == 2:
        failures.append(f"CRAP 超过 {CRAP_THRESHOLD}：拆分函数或补测试")
    elif crap.returncode:
        failures.append(f"crapper 失败（退出码 {crap.returncode}）")
    failures += [f"没有 CRAP 分（覆盖率缺失）：{name}" for name in crap_unmeasured(crap.stdout)]
    dry = _run([*_tool(home, "dryer"), *package.tool_args(), "--threshold", DRY_THRESHOLD])
    if dry.returncode:
        failures.append(f"dryer 失败（退出码 {dry.returncode}）")
    failures += [f"重复（相似度 >= {DRY_THRESHOLD}）：{pair}" for pair in dry_offenders(dry.stdout, set(changed))]
    if mutate:
        mutation = _run([*_tool(home, "mutator"), *package.tool_args(), *changed])
        if mutation.returncode == 3:
            failures.append("有存活的变异体：补断言杀掉，或删掉死代码")
        elif mutation.returncode:
            failures.append(f"mutator 失败（退出码 {mutation.returncode}）")
        gaps = mutation_gaps(mutation.stdout)
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
    home = tools_home(ROOT)
    failures = [failure for package in packages(scope) if package.own(changed)
                for failure in _check_package(package, home, package.own(changed), mutate="--mutate" in argv)]
    for failure in failures:
        print(f"质量门禁失败：{failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))