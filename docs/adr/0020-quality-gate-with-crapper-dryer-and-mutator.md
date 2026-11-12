---
status: accepted
---

# 用 crapper、dryer、mutator 对本次改动做质量门禁

2026-11-08 决定（[#94](https://github.com/qinyuanj/kacha/issues/94)）：接入 [uml-viewer](https://github.com/qinyuanj/uml-viewer) 及其质量工具 crapper、dryer、mutator，并把它们当门禁，而不仅用来看图。门禁只查**本次改动**：取 `merge-base(HEAD, origin/main)..HEAD` 的新增、修改、重命名文件，加上未提交和未跟踪的文件，再限定在 `client/src`（TypeScript）与 `server/src`（Rust）里。以下任一情况都算失败：

- 改动文件里有函数的 CRAP 超过 10；
- 有重复度不低于 0.8、且至少一边落在改动文件里的配对；
- 改动文件里有存活的变异体，或有没被测试覆盖的变异点。

CRAP 和 dryer 进 `verify.py` 的默认流程，需要本地检查时手动运行。mutator 只在 `verify.py --quality` 时跑，合入集成分支前必须手动运行。工具本身出故障也算失败。范围只在 `uml-quality.json` 里声明一次。

2026-11-12 补充（[#106](https://github.com/qinyuanj/kacha/issues/106)、[#110](https://github.com/qinyuanj/kacha/issues/110)）：非 Draft PR 在同一个稳定的 PR Verify check 中复用默认 `verify.py`，并把实际目标分支作为 `--base`。目标为 `main` 或 `integration/*` 时，同一 job 先安装 Chromium，再通过现有 `--e2e` 强制开关运行全套 e2e；其他目标分支不安装 Chromium，也不运行 e2e。修改 PR 目标分支会重新计算验证范围。e2e 因此从集成分支合入后提前到 PR 合入前，worker、真实服务端以及本地手动 `verify.py` 按当前分支判断的默认行为不变。mutator 仍只在维护者本地手动 `verify.py --quality` 中运行，是合入集成分支前的要求，不进入 CI。

工具从哪儿来改过一次（2026-11-11，[#102](https://github.com/qinyuanj/kacha/issues/102)，见 [ADR 0022](0022-quality-tools-from-dsh-uml-viewer-binary.md)）：crapper、dryer、mutator 现在都编译在 dsh-uml-viewer 的单个 `uml-viewer` 二进制里，门禁调用 `uml-viewer crap|dry|mutate` 子命令，二进制来自 `UML_VIEWER_BIN` 或 DSH 插件；原来固定在 `PINS` 里、装在主 checkout `.uml-viewer/` 下的三个 Python 工具与安装器都已删除。上面这些判定规则不受影响。

## Considered Options

- **只看不拦（advisory）**：否决。不拦的指标没人看，问题会一直积累。
- **绝对阈值（全仓库达标才放行）、棘轮式基线**：否决。全仓库达标要先清完存量，基线清单要多维护一份状态；只查改动不受历史问题拖累，也和 mutator 的差分运行一致。
- **直接用工具的 `--changed`**：否决。它只看工作区相对 HEAD 的改动，改动提交后就会是空集。
- **mutator 也进默认流程**：否决。在 Windows 上它为每个变异体整份复制项目（连同 `node_modules`），太慢，不适合默认验证每次都跑。
- **通过每个项目里的入口脚本（当时的 `uml.cmd`）调用工具**：否决。那样每个 worktree 都要各装一遍，安装器每次都 `cargo build --release` 一遍 viewer，而门禁用不到 viewer；后来门禁改为直接调二进制，`uml.cmd` 也随之删掉了（[ADR 0022](0022-quality-tools-from-dsh-uml-viewer-binary.md)）。
- **提交 `.metrics/`（上游的做法）**：否决。门禁只看本次运行的结果，提交快照会让每张票都夹带大量和改动无关的 diff。
- **依赖规则（policy `:levels`）进门禁**：暂不。分层本身要另行决定。

## Consequences

- 第一次改动某个文件时，就要为这个文件的存量问题负责，哪怕超标的函数不是这次改的。
- 开发机多了前置：Rust 1.99.1 MSVC、`cargo-llvm-cov`（crapper 缺了会自动装），以及一份带 `--copy` 的 uml-viewer 二进制（DSH 插件或 `UML_VIEWER_BIN`，见 [ADR 0022](0022-quality-tools-from-dsh-uml-viewer-binary.md)）。原先要求的 Python 3.12+ 与 Herdr ≥ 0.9.3 随着旧安装器一起消失了。
- mutator 在 Windows 上的隔离不是 OS 边界：用绝对路径、注册表或网络的测试仍能越出复制出来的项目副本；仓库里有目录符号链接或 junction 时，它会拒绝运行。副本里只有被运行的那个包，包外依赖要显式 `--copy` 进去；仓库根的 `contracts/` 就是靠 `--copy ../contracts` 补的（见 [ADR 0022](0022-quality-tools-from-dsh-uml-viewer-binary.md)）。
- 三个工具都按包运行（`--root client`、`--root server`），不以仓库根运行。最初的原因是 vitest 写出的 lcov 路径相对 `client/`，以仓库根运行时 crapper 对不上，覆盖率成了 N/A（上游 [crapper#11](https://github.com/qinyuanj/crapper/issues/11)）；crapper `5f4ddce` 起把 TypeScript 和 Python 的 SF 锚定到包目录，这个原因不再成立。门禁仍按包运行：mutator 在 Windows 上只复制所在的包，不会复制仓库根下的 worktree，覆盖率报告和 `.metrics/` 也都落在包内（`client/target`、`server/target`、`*/.metrics`）。按包运行的另一面是包外目录不在副本里，源码依赖到的要显式 `--copy`（[ADR 0022](0022-quality-tools-from-dsh-uml-viewer-binary.md)）。
- 改动文件里有函数没有 CRAP 分（覆盖率缺失）也算失败。一个包里没有任何函数测到覆盖率时，带 `--threshold` 的 crapper 会退出 3；只有部分函数 N/A 时仍退出 0。门禁对两种情况都判失败，后者从报告里判断。
