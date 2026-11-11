---
status: accepted
---

# 质量门禁改用 dsh-uml-viewer 的单个 uml-viewer 二进制

2026-11-11 决定（[#102](https://github.com/qinyuanj/kacha/issues/102)）：crapper、mutator、dryer 已经移植进 [dsh-uml-viewer](https://github.com/qinyuanj/dsh-uml-viewer) 的 Rust 二进制，以 `uml-viewer crap|mutate|dry` 三个子命令提供（上游把三个 Python 工具收进二进制的决定）。kacha 的门禁因此不再从 `.uml-viewer/` 里三个 Python 工具的 venv 按包调用，也不再固定 commit、不再有安装器：`packaging/install_quality_tools.py` 的 `PINS`、仓库根的 `uml.cmd`、`.gitignore` 里的 `# BEGIN UML-VIEWER` 段与 `verify.py` 的安装检查一并删除。[ADR 0020](0020-quality-gate-with-crapper-dryer-and-mutator.md) 里**只查本次改动、阈值不变、按包运行**这些约定仍然成立，本文只替换「工具从哪儿来」那一层。

二进制按顺序找两处，都没有就报错退出，不猜路径、不回退到旧安装：

- `UML_VIEWER_BIN`：二进制的绝对路径，优先；
- 否则用 DSH 插件：`$DSH_HOME`（默认 `~/.dsh`，Windows 上是 `%USERPROFILE%\.dsh`）下 `dsh-uml-viewer/current.json` 记下的版本目录里的 `uml-viewer[.exe]`。

报错文本要同时给出两条路：装 DSH 的 `dsh-uml-viewer` 插件（`dsh plugin add dsh-uml-viewer`），或 `UML_VIEWER_BIN` 指到一份已有的二进制。发现逻辑是 `packaging/quality.py` 的纯函数 `viewer_binary()`，环境变量与插件目录都由参数传入，单测不需要真的装插件。

mutator 的复制范围要补一件事：在 Windows 上它为每个变异体只复制被运行的那个包（`--root client` / `--root server`），包外依赖不在副本里，改动文件的基线测试一读就失败，整个变异运行退出 2——这正是 [#102](https://github.com/qinyuanj/kacha/issues/102) 的表现。client 的基线实测依赖仓库根三处：`contracts/`（画板策略与网关实测夹具）、`docs/release/`（`changelog.test.ts` 与 `ui/ChangelogDialog.tsx` 的 `?raw` import 读更新说明）、`server/Cargo.toml`（同一守护测试读版本号）。门禁因此给 mutator 追加 `--copy ../contracts --copy ../docs/release --copy ../server/Cargo.toml`（模块常量 `MUTATION_COPIES`）：client、server 都是仓库根的直接子目录，两个包的相对路径相同；单文件依赖也可以 `--copy`（上游会连父目录一起建）。这个开关是上游为本次修复新加的，带 `--mutate` 时先读 `uml-viewer mutate --help`，不认识 `--copy` 就**明确失败**并说明需要带该开关的构建，不静默跳过（默认流程不跑 mutator，不受影响）。

未覆盖变异点的判定跟着改。Rust mutator 不再打印 Python 版的 `Total` 行，只按文件打印 `path: executed=N reused=N`；未覆盖的变异点只落在包内 `.metrics/mutate/*.edn` 快照的 `:forms` 里（每项有 `:file` 与 `:uncovered`）。门禁解析这些快照，累加 `:file` 属于本次改动文件的 `:uncovered`，语义仍是「有未覆盖变异点即失败」。其它判定——CRAP 超过 10、没有 CRAP 分、dryer 配对、退出码 2/3 的映射、工具异常算失败——保持不变。

## Considered Options

- **继续用三个 Python 工具的 venv**：否决。上游已把三个工具移植进二进制并且在 Rust 侧维护，继续钉 Python 版等于长期维护两套实现，还要多背 Python 3.12+ 与 Herdr（旧安装器强制检查）这些前置。
- **把 uml-viewer 二进制装进 `.uml-viewer/` 由安装器管**：否决。那样每个 clone / worktree 仍要跑一次安装、每次 `cargo build --release` 一遍 viewer；DSH 插件本来就把同一份二进制按版本装在 `.dsh` 下，直接用它不必再维护第二份副本和一份 `PINS`。
- **把二进制路径写死在仓库里**：否决。开发机与部署机的安装位置不同，写死会让新 clone 上的门禁直接跑不起来。
- **从 `PATH` 里找 `uml-viewer`**：否决。PATH 上的东西不受版本控制，也容易被另一个项目的同名程序顶掉；`UML_VIEWER_BIN` 加 DSH 插件这两条显式路径够用，出错时的提示也具体。
- **让 mutator 自动收集包外依赖**：暂不。自动推断要解析 TS / Rust 的 import 与相对路径，门禁会多出一层看不见的判定逻辑；显式列目录（`MUTATION_COPIES`）一行就能读明白。
- **没有 `--copy` 时跳过变异测试并记一条警告**：否决。跳过等于把这条门禁悄悄关掉，运行的人只会看到「通过」。
- **继续用 `Total` 行的正则数未覆盖变异点**：否决。Rust mutator 根本不打印那行，正则永远得 0，这条门禁会静默失效；改读 `.metrics/mutate` 快照里的 `:forms`。

## Consequences

- 开发机前置变了：不再需要 Python 3.12+ 与 Herdr ≥ 0.9.3（旧安装器的强制检查），改为需要一份带 `--copy` 的 uml-viewer 二进制（DSH 插件或 `UML_VIEWER_BIN`）。Rust 侧仍要有 `cargo-llvm-cov`（crapper 缺了会自动装）。`.uml-viewer/` 不再是本仓库的忽略项，旧检出里残留的那份可以直接删。
- 工具版本不再由仓库固定，升级跟着 DSH 插件（或 `UML_VIEWER_BIN` 指向的构建）走；报告格式一类的行为变化由 `packaging/tests/test_quality.py` 的单测兜住，不靠人工比对。
- 未覆盖变异点的判定依赖 mutator 写出的 `.metrics/mutate/*.edn`。快照是差分维护的：改过的文件被本次运行重写，没改的保留上次结果，所以门禁只统计本次改动的文件，与「只查改动」一致。
- Windows 上变异工作副本仍然只有被运行的包；包外依赖靠 `--copy` 补进去（现在是 `contracts/`、`docs/release/`、`server/Cargo.toml` 三处，见上），仓库里其他包外路径将来若被源码依赖，也要往 `MUTATION_COPIES` 里加一条。补漏的代价是基线直接失败并退出 2，不会静默通过。
- `client/target`、`server/target`、包内 `.metrics/` 的完整性标签注意事项见 [packaging/README.md](../../packaging/README.md)「验证」。
