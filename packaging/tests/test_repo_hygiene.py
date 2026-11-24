"""#245：跟踪树里不能出现 node_modules 这类安装产物。

client/node_modules 曾以 mode 120000（符号链接）被提交，blob 内容是某台机器的绝对路径
D:/dev/github/kacha/client/node_modules；构建期 npm ci 把它换成真实目录，于是每次构建后
工作树都多一条 " D client/node_modules"。仓库的 .gitignore 早就忽略 node_modules/，所以
这条跟踪本身就是误跟踪。这里守住「跟踪树里没有任何 node_modules 路径」：它一旦回来，
本测试就红，而不是等下一次 git add -A 悄悄改掉跟踪关系。
"""

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
"""仓库根：packaging/tests/test_repo_hygiene.py 往上三级。"""


def tracked_paths(root: Path) -> list[str]:
    """git 跟踪的全部路径。git 缺失或仓库损坏时直接抛错，不静默跳过。"""
    done = subprocess.run(["git", "-c", "core.quotepath=false", "ls-files", "-z"],
                          cwd=root, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=True)
    return [path for path in done.stdout.split("\0") if path]


class TrackedTreeTest(unittest.TestCase):
    def test_no_node_modules_path_is_tracked(self):
        offenders = [path for path in tracked_paths(ROOT) if "node_modules" in Path(path).parts]
        self.assertEqual(offenders, [], "#245：node_modules 是安装产物，只能由 npm ci 生成，不该进跟踪树")


if __name__ == "__main__":
    unittest.main()
