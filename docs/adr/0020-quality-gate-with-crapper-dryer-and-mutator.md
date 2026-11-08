---
status: accepted
---

# 推送前用 crapper、dryer、mutator 对本次改动做质量门禁

2026-11-08 决定（[#94](https://github.com/qinyuanj/kacha/issues/94)）：接入 [uml-viewer](https://github.com/qinyuanj/uml-viewer) 及其质量工具 crapper、dryer、mutator，并把它们当门禁，而不仅用来看图。门禁只查**本次改动**：取 `merge-base(HEAD, origin/main)..HEAD` 的新增、修改、重命名文件，加上未提交和未跟踪的文件，再限定在 `client/src`（TypeScript）与 `server/src`（Rust）里。以下任一情况都算失败：

- 改动文件里有函数的 CRAP 超过 10；
- 有重复度不低于 0.8、且至少一边落在改动文件里的配对；
- 改动文件里有存活的变异体，或有没被测试覆盖的变异点。

CRAP 和 dryer 进 `verify.py` 的默认流程，pre-push 每次都跑。mutator 只在 `verify.py --quality` 时跑，合入集成分支前必须跑。工具本身出故障也算失败；要绕过只能用 git 的 `--no-verify`。范围只在 `uml-quality.json` 里声明一次。四个仓库固定在 `packaging/install_quality_tools.py` 的 `PINS` 里，安装在主 checkout 的 `.uml-viewer/` 下，所有 worktree 共用。

## Considered Options

- **只看不拦（advisory）**：否决。不拦的指标没人看，问题会一直积累。
- **绝对阈值（全仓库达标才放行）、棘轮式基线**：否决。全仓库达标要先清完存量，基线清单要多维护一份状态；只查改动不受历史问题拖累，也和 mutator 的差分运行一致。
- **直接用工具的 `--changed`**：否决。它只看工作区相对 HEAD 的改动，pre-push 时改动都已提交，会是空集。
- **mutator 也进默认流程**：否决。在 Windows 上它为每个变异体整份复制项目（连同 `node_modules`），太慢，不适合每次推送都跑。
- **通过 `uml.cmd` 调用工具**：否决。那样每个 worktree 都要各装一遍，安装器每次都 `cargo build --release` 一遍 viewer，而门禁用不到 viewer。
- **提交 `.metrics/`（上游的做法）**：否决。门禁只看本次运行的结果，提交快照会让每张票都夹带大量和改动无关的 diff。
- **依赖规则（policy `:levels`）进门禁**：暂不。分层本身要另行决定。

## Consequences

- 第一次改动某个文件时，就要为这个文件的存量问题负责，哪怕超标的函数不是这次改的。
- 开发机多了前置：Rust 1.99.1 MSVC、Python 3.12+（mutator 在 Windows 上需要）、Herdr ≥ 0.9.3（uml-viewer 安装器强制检查，门禁本身用不到）、`cargo-llvm-cov`（crapper 缺了会自动装）。
- mutator 在 Windows 上的隔离不是 OS 边界：用绝对路径、注册表或网络的测试仍能越出复制出来的项目副本；仓库里有目录符号链接或 junction 时，它会拒绝运行。
- 三个工具都按包运行（`--root client`、`--root server`），不以仓库根运行。原因是 vitest 写出的 lcov 路径相对 `client/`，以仓库根运行时 crapper 对不上，覆盖率成了 N/A（上游 [crapper#11](https://github.com/qinyuanj/crapper/issues/11)）。附带的好处是 mutator 在 Windows 上只复制所在的包，不会复制仓库根下的 worktree。覆盖率报告和 `.metrics/` 也都落在包内（`client/target`、`server/target`、`*/.metrics`）。
- 改动文件里有函数没有 CRAP 分（覆盖率缺失）也算失败。crapper 在这种情况下仍退出 0，门禁要自己从报告里判断。
