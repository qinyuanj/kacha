# MyGo Go 壳与当前 React / Rust Web stack 的开发效率调研

- 调研日期：2026-11-14（Asia/Shanghai）。
- 当前项目：Kacha，commit `fc10c8c81f41837fe3f62597b7bcc5737f81d1da`。
- MyGo 源码快照：`egoist/mygo` commit `46c97276cd5390884e17695ac830896add909c4f`；其 CLI 自报 `mygo 0.9.0`。快照位于 v0.9.0 之后，**不能把它写成 v0.9.0 tag 本身的构建结果**。[版本与环境原始记录](../../.scratch/mygo-efficiency-20261114/environment.json#L1-L26)
- 路线前提：用户已确认本地优先桌面路线。本报告比较开发效率，不重新讨论是否回到多人 Web 服务。
- 证据规则：官方文档、官方源码、当前项目源码 / 构建脚本与历史 tag 为 primary sources；文档事实和本机实测分开；没有数据的项目明确写「未知」。

## 0. 结论先行

1. **建议进入 MyGo 验证性 spike，不建议现在就全量重写为 Go。** 最小 MyGo 壳的原生构建数字优于当前完整 Rust 服务端，但二者功能范围不同；全部 Rust 业务移植后的 cold / warm / incremental 时间仍然**未知**。[A 原始结果](../../.scratch/mygo-efficiency-20261114/benchmark/results-complete.json#L47-L77) [B 原始结果](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo-complete.json#L1-L86)

2. **前端日常开发效率最有可能基本持平。** A 已用 Vite + React Fast Refresh；MyGo web frontend 也是由 Vite dev server 提供 hot reload，Go 改动才走原生 rebuild / restart。[当前 Vite 配置](../../client/vite.config.ts#L1-L14) [React 插件说明](../../client/node_modules/@vitejs/plugin-react/README.md#L3-L17) [MyGo 前端文档](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L20-L35)

3. **MyGo 的 typed binding 是实际效率收益，但生成不是零成本。** 当前 A 在 HTTP 边界手写 TS 类型并做 `api<T>` 断言；MyGo 可从 Go 服务生成 TS 客户端。探针中 cold 全链 37.912s，其中绑定生成阶段约 18.5s；无改动和单次 Go 改动后的全链分别约 4.206s、3.978s。[当前 HTTP 泛型断言](../../client/src/shell/ipc.ts#L63-L67) [MyGo 生成文档](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L102-L147) [全链阶段日志](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo-complete-full-debug-cold.log#L4-L26)

4. **全 Go 移植的主要工作量不是 React，而是 Rust 业务、测试与本地身份语义。** 当前物理行统计为：`server/src` 6,929 行、`server/tests` 4,076 行、`client/src/shell` 965 行产品代码 + 120 行路径形式测试文件。它们是「迁移接触面」，不是「必然改写行数」或工时估算。[统计方法与原始计数](../../.scratch/mygo-efficiency-20261114/migration-surface.json#L1-L20)

5. **若优先降低迁移风险，可先验证 MyGo + 现有 Rust sidecar；若优先降低 Rust 业务编译成本，则必须做真实 Go 业务模块移植。** sidecar 能复用 Rust，但 Rust 原生改动重建成本仍在，也不再是纯 Go / 单一工具链；MyGo 官方支持按平台打包 helper executable。[MyGo helper executable 文档](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/distribution.md#L176-L228)

6. **包体、冷启动、内存不能宣布胜负。** 本次只有最小 MyGo debug 探针 exe 的原始大小，没有功能等价安装包、冷启动或全进程内存对照；A 与历史 C 的已有数字也都不是同一口径。[实测覆盖边界](#32-实测覆盖范围与禁止外推)

---

## 1. 比较对象与证据边界

### 1.1 三个对象严格分开

| 对象 | 定义 | 主要证据 |
|---|---|---|
| **A：当前 Web stack** | React 19 + TypeScript + Vite，Rust/axum 服务端；浏览器经同源 HTTP 调服务端 | [依赖与脚本](../../client/package.json#L5-L31) [axum 依赖](../../server/Cargo.toml#L13-L46) [HTTP 壳注释](../../client/src/shell/ipc.ts#L1-L18) |
| **B：MyGo Go 壳 + 同一 React 前端** | OS WebView2 中运行同一 React 前端；Go 壳可采用 typed bindings、custom HTTP protocol 或 Rust helper，三种接缝不混为一种实现 | [MyGo web frontend](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/README.md#L3-L17) [custom protocol](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L78-L107) |
| **C：历史 v0.3.2 Tauri 2 + React** | 仅作 Rust 桌面壳参照，不是 A，也不是 B；不拿 C 的实测冒充 A/B | [历史 package.json](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/package.json) [历史 Cargo.toml](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/src-tauri/Cargo.toml) [退役 ADR](../../docs/adr/0018-web-app-replaces-desktop-client-with-server-side-task-directories.md#L5-L9) |

A 的当前开发入口是 `client/npm run dev` 与另起的 `server/cargo run`，Vite 将 `/api` 代理到 `localhost:3004`。[README 开发说明](../../README.md#L43-L47) [Vite proxy](../../client/vite.config.ts#L5-L13)

C 的 `build:desktop` 是 `tauri build --debug`；其 `tauri.conf.json` 配置 `beforeDevCommand: npm run dev`、`devUrl: http://localhost:1420`。这些都是历史 tag 的事实，未在本轮重新构建。[历史 package.json](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/package.json) [历史 tauri.conf.json](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/src-tauri/tauri.conf.json)

### 1.2 本轮实际做了什么

- 阅读当前源码、构建与验证脚本、历史 v0.3.2 文件，以及固定 commit 的 MyGo 官方源码 / 文档。
- 在 `.scratch/mygo-efficiency-20261114/` 保留探针、命令、原始 JSON 和日志；正式产品源码只新增本报告。
- 初始本机为 Go 1.26.4；探针通过 Go 官方 `GOTOOLCHAIN=go1.27.3` 按需补齐工具链，没有替换系统 Go。MyGo `go.mod` 要求 Go 1.27.3。[MyGo go.mod](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/go.mod#L1-L16) [环境记录](../../.scratch/mygo-efficiency-20261114/environment.json#L12-L24)
- 顺序执行 A 的 7 次成功构建 / 检查和 B 的 6 次成功构建；没有并行编译负载。[A 结果](../../.scratch/mygo-efficiency-20261114/benchmark/results-complete.json#L1-L79) [B 结果](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo-complete.json#L1-L86)
- **未做**：启动桌面应用、启动产品服务、运行任何 e2e、release 部署构建、安装器构建、真实发布、清理现有构建缓存。
- MyGo 全链中的 `mygo build -debug -skip-installer` 会生成绑定；官方说明生成阶段构建并以 `MYGO_GENERATE` 运行程序，`App.Run` 随后返回且不打开窗口。[MyGo bindings 文档](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L144-L147)

工作区原先已有 `GLOSSARY.md` 与 `docs/adr/0021-clipboard-paste-dispatch-by-clipboard-content.md` 修改；本调研没有改动它们。[环境记录](../../.scratch/mygo-efficiency-20261114/environment.json#L1-L6)

---

## 2. 文档事实：开发效率逐项比较

### 2.1 前端 HMR 与原生改动重建

**A**

- Vite 提供 HMR，当前 `@vitejs/plugin-react` 默认启用 React Fast Refresh。[Vite README](../../client/node_modules/vite/README.md#L12-L18) [React 插件 README](../../client/node_modules/@vitejs/plugin-react/README.md#L3-L17)
- 当前文档要求分别运行 Vite 与 `cargo run`；仓库开发文档没有给出统一的 Rust watch / restart 命令。因此，前端改动与 Rust 改动是两条不同闭环。[README](../../README.md#L43-L47)
- 本轮没有启动 dev server，**HMR 延迟与 Rust 改动到页面可用的时间未知**。

**B**

- `mygo dev` 在 Go、配置、图标或资源变化时 rebuild + restart；编译失败保留上一个可运行实例。[Getting started](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/getting-started.md#L94-L111)
- web frontend 仍由 Vite dev server 处理页面更新；CLI 文档明确说前端变化交给 dev server，Go 变化还会重新生成 TS client 并重启 app。[MyGo CLI dev](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/cli.md#L90-L116)
- **判断**：单命令 watch / restart 是 B 的操作便利；这不等于已证明其端到端 rebuild 更快。本轮未运行 `mygo dev`，窗口重启与状态恢复时间未知。

**C**

- 历史 Tauri 使用 Vite devUrl 与 `beforeDevCommand`；它是另一个 Rust 桌面壳参照，不与 B 的 `mygo dev` 合并。[历史 tauri.conf.json](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/src-tauri/tauri.conf.json)

### 2.2 Go / Rust 绑定与类型生成

**A 当前是手写 HTTP 合同。** `api<T>` 最终把 JSON 断言为 `T`，`Ipc`、`SessionPort` 等类型在 TS 侧手写；Rust 路由在 `server/src/lib.rs` 独立维护。未发现由 Rust 生成这些 TS 类型的项目脚本。[TS 断言](../../client/src/shell/ipc.ts#L63-L79) [TS 端口](../../client/src/shell/types.ts#L43-L80) [Rust 路由](../../server/src/lib.rs#L234-L281)

**B 可生成 TypeScript client。** `mygo generate` 根据绑定服务、channel 与 typed event 生成客户端；`mygo dev` 在 Go 变化时重新生成，`mygo build` 在前端构建前生成。[Bindings](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L1-L7) [Generated client](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L102-L177)

本轮探针实际生成了 `Greeter.greet(name: string): Promise<string>`，证明该机制在所用快照上工作；但当前 Kacha 前端尚未改成调用它。[生成的 mygo.ts](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo.ts#L1-L12)

生成器会构建并运行到 `App.Run`，所以 Go API 改动包含「生成 + 原生重建 + app restart」，不是单纯文本 codegen。[Bindings 生成过程](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L144-L147)

**重要分支**：若 B 为减少迁移而保留现有 `/api` HTTP 合同，则不会自动获得上述 typed binding 收益；MyGo custom protocol 只是接受 `http.Handler`。[Custom protocol](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L78-L107)

**C 也不是自动类型生成参照。** 历史 `ipc.ts` 使用 `invoke<AppPaths>`、`invoke<BoardTexts>` 等手写泛型包装，历史 package.json 未声明类型生成工具。[历史 ipc.ts](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/src/shell/ipc.ts) [历史 package.json](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/package.json)

### 2.3 测试与调试闭环

**A 已有闭环**

- `npm test` 是 Vitest，`typecheck` 是 `tsc --noEmit`；统一验证还运行 Rust `cargo test --no-fail-fast`。[前端脚本](../../client/package.json#L5-L12) [verify.py](../../packaging/verify.py#L21-L33)
- 当前 Playwright 配置是「真浏览器 + 真服务端 + 每测试独立临时数据根」，失败保留 trace。[playwright.config.ts](../../client/playwright.config.ts#L12-L26)
- e2e global setup 构建 debug 服务端与前端，rig 启动真实 `kacha-server` 和本地网关 / 对象存储桩。[global-setup.ts](../../client/e2e/global-setup.ts#L1-L9) [rig.ts](../../client/e2e/web/rig.ts#L1-L18) [rig.ts 服务端进程](../../client/e2e/web/rig.ts#L116-L145)

**B 可保留前端单测，但不能把现有 e2e 当作桌面验收**

- MyGo dev 提供 Web Inspector；普通浏览器打开页面时没有 MyGo runtime，绑定调用会 reject，因此「浏览器通过」不能覆盖真实 Go 壳。[Getting started](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/getting-started.md#L107-L111) [Frontend runtime](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L257-L294)
- 官方 automation 可从外部进程截图、等待 idle、对页面执行 JS；但 web page 没有 accessibility `tree`，页面也不接受原生 `input`，文档要求用 `eval` 驱动。因此，现有 Playwright 的真实 pointer / keyboard 桌面闭环需要重新设计，而非直接改一个 URL。[Automation page 限制](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/plugins/automation.md#L178-L180) [Automation eval](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/plugins/automation.md#L255-L279)
- 全 Go 移植时，`server/tests` 的 Rust 集成测试必须移植、替换或以合同测试保留；浏览器 Vitest 不因换壳自动验证 Go 业务。[测试接触面统计](../../.scratch/mygo-efficiency-20261114/migration-surface.json#L1-L20)

本轮没有运行任何单测或 e2e；上述是源码 / 文档中的测试结构，不是本轮通过率。

### 2.4 Windows 依赖与交叉编译

| 对象 | 文档事实 | 效率 / 升级含义 |
|---|---|---|
| A | 构建机使用 Rust、Node、Python 3.11+；部署机只需服务端程序和 `static/`，不需 Rust、Node、Python。Linux 标注「不再实测」。[packaging/README.md](../../packaging/README.md#L5-L32) | 当前 Windows 开发链已存在；没有本项目交叉构建已验证的证据，交叉结果写未知。 |
| B | web frontend 需要 Go 1.27+、Bun；Windows 10 需要 WebView2 Runtime，Windows 11 已包含。MyGo `go.mod` 当前进一步写 Go 1.27.3。[Requirements](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/README.md#L182-L207) [go.mod](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/go.mod#L1-L4) | 本机原 Go 版本不满足，探针需按需下载指定工具链；这是实际升级成本，不是理论成本。 |
| B | CLI 默认 `CGO_ENABLED=0`，文档称可从任一机器编译各平台；若业务引入 cgo，则需要目标 C 编译器 / 交叉编译器。[Distribution platforms](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/distribution.md#L26-L43) | 「全 Go 业务」才能完整保留这一优势；Rust sidecar 或 native module 不能直接套用纯 Go 结论。 |
| B | Windows 安装器使用 NSIS；Windows 上未安装时首次构建会下载并缓存，`-skip-installer` 不查找或下载 NSIS。非 Windows 制作 Windows installer 需要已安装 NSIS。[Windows installer](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/distribution.md#L478-L490) | 本轮使用 `-skip-installer`，所以没有触发 NSIS 下载，也没有测安装器时间。 |
| B + Rust native module | 官方仍标为 Experimental；Rust 跨平台还需要 target 与 linker，部分路径使用 cargo-zigbuild，macOS 库需要 Apple SDK。[Native modules 状态](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/native-modules.md#L1-L14) [Rust cross 说明](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/native-modules.md#L1081-L1090) | 不能把「MyGo 无 cgo」写成「保留所有 Rust 业务后仍可无约束交叉编译」。 |
| C | 历史项目打包文档明确写「Tauri 不能交叉构建，两个平台各在对应机器执行」。这是**该历史项目流程**的证据，不扩大成所有 Rust 项目都不能交叉编译。[历史 packaging/README.md](https://github.com/qinyuanj/kacha/blob/v0.3.2/packaging/README.md) | C 仅作桌面壳参照。 |

### 2.5 框架成熟度与升级成本

- MyGo 首个 `v0.1.0` tag 的 commit 时间为 2026-09-27，`v0.9.0` 为 2026-11-11；本轮官方远端有 80 个匹配 `vX.Y.Z` 的 tag。发布密集本身不证明不稳定，但说明采用时必须 pin 版本并保留升级验证，而不能跟随移动的 `main`。[v0.1.0 commit](https://github.com/egoist/mygo/commit/230106d8bac5f3821b33920e3f45a9f40ea0684a) [v0.9.0 commit](https://github.com/egoist/mygo/commit/4811a2869b5a66d2b7e21a9eb5993fcff544460b) [官方 tags](https://github.com/egoist/mygo/tags) [本地版本记录](../../.scratch/mygo-efficiency-20261114/environment.json#L18-L25)
- 本报告使用的是 v0.9.0 之后的 main commit `46c9727`，而不是 tag `4811a28`。正式 spike 应另选并固定其中一个，不混用文档与二进制版本。[环境记录](../../.scratch/mygo-efficiency-20261114/environment.json#L18-L23)
- Native modules 明确允许任何 release 做 breaking change；核心 web frontend / bindings 并未在这段文字中承诺相同稳定性，因此不能扩大或缩小这段警告。[Native modules](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/native-modules.md#L1-L7)
- MyGo automation CLI 不随 app 的 MyGo 自动升级，官方要求升级 app 后重新安装对应 CLI；测试工具链也要纳入版本管理。[Automation CLI upgrade](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/plugins/automation.md#L376-L396)
- C 使用的 Tauri 2 官方在 2024-10 发布 stable；这只能说明 C 的框架历史更长，不证明当前业务迁移成本更低。[Tauri 2.0 Stable Release](https://tauri.app/blog/tauri-20/) [历史 Tauri 依赖](https://github.com/qinyuanj/kacha/blob/v0.3.2/client/src-tauri/Cargo.toml)

---

## 3. 本机实测：命令、定义与原始结果

### 3.1 机器、commit 与 cold / warm 定义

机器为 Windows 11 build 26220、AMD Ryzen 5 5500（6 核 12 线程）、34,247,663,616 bytes 内存；Node 24.22.1、npm 12.2.2、Rust 1.99.1、Bun 1.3.13；B 使用 Go 1.27.3。完整版本见[环境记录](../../.scratch/mygo-efficiency-20261114/environment.json#L1-L26)。

- **A cold**：从 HEAD 将 `server` 与编译期 `contracts/board-policy.json` 复制到新的 scratch 目录；`CARGO_TARGET_DIR` 是此前不存在的 `cargo-target-complete`。Cargo registry / source 与 OS 缓存保留；默认 debug profile、默认 Cargo 并行度。
- **A warm / no-op**：同一 target、同一源码，立即重复 `cargo build`，没有任何源文件变化。
- **A incremental**：只给 scratch `server/src/lib.rs` 追加一个未使用私有 const，再用同一 target 构建。正式 `server` 未改。[A 脚本](../../.scratch/mygo-efficiency-20261114/benchmark/benchmark-complete.ps1#L43-L53)
- **B cold**：`GOCACHE` 为新的空目录；`GOMODCACHE`、已下载 Go toolchain 与已安装到 scratch 的 MyGo CLI 保留；`CGO_ENABLED=0`。
- **B warm / no-op**：同一 GOCACHE、同一生成输出、无源码变化，立即重复命令。
- **B incremental**：只给 scratch `main.go` 追加未使用 const，再以同一 GOCACHE 构建。[B 脚本](../../.scratch/mygo-efficiency-20261114/mygo-probe/benchmark-mygo-complete.ps1#L35-L49)
- 所有秒数都是 PowerShell `Stopwatch` 的进程墙钟时间，单次运行，未做统计分析；不是官方 benchmark，也不是多台机器均值。

### 3.2 原生构建结果

| 对象 / 范围 | cold | warm no-op | 一次小增量 | 原始证据 |
|---|---:|---:|---:|---|
| A：完整当前 `kacha-server`，`cargo build` debug | **47.294s** | **0.397s** | **3.944s** | [results-complete.json:47-77](../../.scratch/mygo-efficiency-20261114/benchmark/results-complete.json#L47-L77) |
| B：最小 MyGo 壳，`go build`；无前端、无业务移植 | **19.022s** | **0.578s** | **1.189s** | [results-mygo-complete.json:1-43](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo-complete.json#L1-L43) |
| B：同一 React + 绑定生成 + debug app 全链；仍是最小 Go 壳 | **37.912s** | **4.206s** | **3.978s** | [results-mygo-complete.json:44-86](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo-complete.json#L44-L86) |
| C：v0.3.2 Tauri 2 | 未知 | 未知 | 未知 | 本轮未构建 C |

**读法限制：**

1. B 的最小壳只有 `Greeter`，没有 A 的 axum 路由、图像、zip、session、cleanup、Windows service 等业务。**不能**由 19.022s 对 47.294s 推导「完整 Go 产品 cold 快 2.5 倍」，也不能由 1.189s 对 3.944s 推导完整产品的增量倍率。[探针 main.go](../../.scratch/mygo-efficiency-20261114/mygo-probe/main.go#L1-L24) [A 当前服务端依赖](../../server/Cargo.toml#L13-L46)
2. B 全链cold包含绑定生成和前端构建，不只是 `go build`；A 的 47.294s 行只含 Rust 服务端，不含 TS / Vite。两行不是同一聚合口径。
3. B 全链的 warm no-op 仍执行绑定检查 / 生成与 Vite 构建，不是纯 Go 缓存查询；A 的 0.397s 只是 Cargo no-op。不能把两个 warm 数字直接相除。
4. 全部 Go 业务完成后的 cold、warm、增量、测试与调试时间仍然**未知**；sidecar 路线的 Rust 业务增量成本不会因 MyGo 壳自动消失。

### 3.3 MyGo 全链的阶段成本

| 阶段 | cold | warm no-op | 小 Go 增量 |
|---|---:|---:|---:|
| TypeScript client 生成 | 约 18.5s，写出 `mygo.ts` | 约 1.7s，已是最新 | 约 1.3s，已是最新 |
| 同一 React 前端 | 696ms | 719ms | 694ms |
| windows/amd64 编译 | 约 17.8s | 972ms | 约 1.1s |
| CLI 汇总 / Stopwatch | 37.9s / 37.912s | 4.2s / 4.206s | 4.0s / 3.978s |

证据分别为 [cold 日志](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo-complete-full-debug-cold.log#L4-L29)、[no-op 日志](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo-complete-full-debug-noop.log#L4-L29)、[incremental 日志](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo-complete-full-debug-incremental.log#L4-L29)。阶段数字由 MyGo CLI 显示、精度较低；Stopwatch 数字来自[原始 JSON](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo-complete.json#L44-L86)。

**判断**：绑定生成是实际开发链的一部分，不能只引用最小 `go build` 的 1.189s 来代表 Go API 改动后的完整体验。官方文档也说明生成器本身会构建 app。[Bindings 生成过程](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L144-L147)

### 3.4 前端检查结果

| 命令 / 范围 | 第一次 | 紧接着第二次 | 说明 |
|---|---:|---:|---|
| `npm.cmd --prefix client run typecheck` | **2.078s** | **1.526s** | 当前 tsconfig 未配置 incremental / tsBuildInfo；两次都执行完整 `tsc --noEmit -p .`，不是 HMR 测量。[结果](../../.scratch/mygo-efficiency-20261114/benchmark/results-complete.json#L1-L23) [tsconfig](../../client/tsconfig.json#L1-L18) |
| Vite `build --mode development --minify false` | **0.641s** | **0.655s** | 294 modules；不是 release 部署构建，也不是 HMR。[结果](../../.scratch/mygo-efficiency-20261114/benchmark/results-complete.json#L24-L45) |

Vite 自己报告的构建时间为 294ms、330ms，和包含 Node 启动等成本的 Stopwatch 墙钟不是同一口径。[run1 日志](../../.scratch/mygo-efficiency-20261114/benchmark/frontend-vite-development-complete-run1.log#L1-L15) [run2 日志](../../.scratch/mygo-efficiency-20261114/benchmark/frontend-vite-development-complete-run2.log#L1-L15)

MyGo 探针也成功构建了同一 React 前端 294 modules，证明**构建层面**可复用；它没有验证当前 `shell/ipc.ts` 与 MyGo runtime 的运行时兼容性。[MyGo 前端日志](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo-complete-full-debug-cold.log#L6-L24)

### 3.5 实测覆盖范围与禁止外推

| 维度 | 本轮状态 |
|---|---|
| A Rust cold / no-op / 小增量 | 已测，各 1 次 |
| B 最小壳 Go cold / no-op / 小增量 | 已测，各 1 次 |
| B 同前端 + 绑定 + debug app 全链 | 已测，各 1 次；未移植 Rust 业务 |
| A/B 前端 typecheck 与 Vite bundle | 仅 A 独立测；B 全链包含 Vite，但没有同一聚合命令下的 TS typecheck |
| 前端 HMR save-to-screen | **未实测**；未启动 dev server / app |
| 原生改动到桌面窗口恢复可用 | **未实测**；只测构建命令 |
| C Tauri 2 编译 | **未实测** |
| 业务代码功能等价后的 Go 构建 | **未知** |
| 单测 / e2e 通过率与调试闭环时间 | **本轮未运行，未知** |
| 功能等价安装包体积、冷启动、内存 | **未知**；未做 release / installer，也未启动 app |
| 自动更新下载、安装、重启与任务保护 | **未实测** |

探针调试过程也保留了失败记录：第一次 Vite 命令未显式传 root，得到 `UNRESOLVED_ENTRY`；第一次 MyGo 命令从仓库根运行，找不到 Go module。它们都是探针脚本错误，不计入成功 timing，也不是产品构建失败。[Vite 失败记录](../../.scratch/mygo-efficiency-20261114/benchmark/results-attempt1.json#L1-L11) [Vite 失败日志](../../.scratch/mygo-efficiency-20261114/benchmark/frontend-vite-development-run1.log#L1-L18) [MyGo 失败记录](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo.json#L1-L14)

---

## 4. 业务代码迁移量与接缝选择

### 4.1 可复用与必须重新验证的面

以下是用 `ops_grep` 的 `^` 对当前文件统计的物理行，含空行；`server/src` 还可能含文件内 Rust 单测。它不是复杂度、工作量或改写比例模型。[完整方法与逐文件计数](../../.scratch/mygo-efficiency-20261114/migration-surface.json#L1-L20)

| 区域 | 产品文件物理行 | 路径形式测试文件物理行 | 对 B 的含义 |
|---|---:|---:|---|
| `client/src/core` | 7,801 | 11,089 | React 无关壳的领域逻辑最有复用价值，但其端口实现要重新验证。 |
| `client/src/ui` | 7,538 | 7,745 | 同一 React 可保留；桌面快捷键、文件、下载、更新与登录 UI 仍需接缝验收。 |
| `client/src/other` | 665 | 0 | App、入口与其他 TS/TSX 文件；构建已证明可打包，运行未测。 |
| `client/src/shell` | 965 | 120 | HTTP / session / upload / download / localStorage 接缝是前端主要改写面。 |
| `server/src` | 6,929 | 0（不含文件内测试拆分） | 全 Go 路线的主要移植面；sidecar 可保留。 |
| `server/tests` | 0 | 4,076 | 全 Go 路线需要移植或以合同测试重建。 |

当前 `server/src/lib.rs` 有 39 个 `.route(...)` 调用，其中一个是 API fallback，另有 `transfer::routes()` 的一个 `merge`；因此不能简单把「39」写成完整 API 端点数。[路由源码](../../server/src/lib.rs#L234-L281)

### 4.2 本地优先不是把当前 Web server 原样藏进桌面

当前 A 以 API 密钥指纹作为用户身份、发放 7 天 cookie，并按用户隔离服务端数据根；`SessionPort` 还包括登录、logout、过期事件与 localStorage 中的密钥操作。[ADR 0018](../../docs/adr/0018-web-app-replaces-desktop-client-with-server-side-task-directories.md#L11-L15) [SessionPort](../../client/src/shell/types.ts#L144-L153)

本地优先单用户下，需要重新决定：

- 多用户指纹隔离、session cookie 与登录页哪些删除、哪些保留为网关凭据验证；
- 当前 Windows service、cleanup、recycle、usage 的哪些语义成为单用户本地功能；
- 当前 localStorage 密钥如何迁移。MyGo 文档明确说明 dev server origin 与打包 app origin 的 localStorage / IndexedDB 不共享，并建议重要数据放入 Go。[MyGo origin 与存储](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L42-L48)

这些问题的代码量未知，不能由物理行数自动给出。

### 4.3 路线 B1：typed Go bindings，全 Go 业务

**潜在收益**：生成 TS 类型、统一 Go 原生构建链、保留 CGO=0 交叉编译路径。[Bindings](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L102-L177) [Cross compile](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/distribution.md#L26-L43)

**成本**：6,929 行 `server/src` 与 4,076 行集成测试构成主要移植接触面；session / local-first 语义还需重设计。**全部成本和最终编译时间未知。**

MyGo 的 channel / typed event 可替代进度轮询，但需要改当前 shell 与 Go 业务双方，不是自动迁移。[Channels / events](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/bindings.md#L219-L333)

### 4.4 路线 B2：MyGo + 现有 Rust sidecar

MyGo 官方允许把另一语言 server 作为按平台资源打包，并从 Go 启动。[Helper executables](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/distribution.md#L176-L228)

**判断**：这是最低业务重写风险的对照路线，可复用当前 axum 与 Rust 测试，但：

- Rust 业务改动仍走 Cargo；本报告中 A 的 3.944s 小增量基线不会因外面换成 Go 壳而消失。
- 每个目标平台仍要提供对应 Rust helper，不能引用纯 Go 的交叉编译结论。
- 进程生命周期、loopback 访问控制、数据迁移与更新时替换两个二进制都需要新验收；本轮未测。
- MyGo 文档提醒 loopback server 可被机器上其他程序访问，应只暴露可读内容或在路径中加入 secret。[Loopback 风险](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L124-L140)

### 4.5 路线 B3：保留 HTTP 合同，改用 MyGo custom protocol

MyGo 可以把 `http.Handler` 暴露给页面，理论上能少改当前 `ipc.ts` 的 REST 形状。[Custom protocol](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L78-L107)

但 Windows WebView2 对 custom scheme 的响应逐个读取；超过 1 MB 的响应可能阻塞其他响应，SSE / long polling 到返回时才送达，官方建议这类更新改用 events。[Windows streaming 限制](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/frontend.md#L109-L122)

当前 A 的画板包导出把 zip 响应读成 blob，另有操作进度轮询；因此大导出与并发进度是 custom protocol 必须实测的风险点，不能直接声称零改动兼容。[导出 blob](../../client/src/shell/ipc.ts#L149-L168) [进度轮询](../../client/src/shell/ipc.ts#L202-L211)

这条路线也不会自动得到 Go struct 到 TS 类型的生成收益。

### 4.6 C 给出的历史经验

Tauri → axum 时，`store.rs`、`board_pack.rs`、`image_info.rs` 等与 Tauri 无耦合的 Rust 模块曾原样迁入，前端主要是 IPC → HTTP。[ADR 0018](../../docs/adr/0018-web-app-replaces-desktop-client-with-server-side-task-directories.md#L5-L9)

**判断**：Rust → MyGo 全 Go 不再享有「同语言模块原样迁入」；sidecar 更接近历史复用路径，typed Go bindings 则是另一种业务边界。C 可帮助估计 Rust 模块边界，不能被写成 B 的构建实测。

---

## 5. 包体、启动、内存：只列有证据的口径

### 5.1 本轮实测

- 最小 MyGo debug 探针 exe 为 **11,937,792 bytes**，CLI 日志显示 11.4 MB；它含同一 React 前端与最小 Go 壳，**不是完整 Kacha，不是 release，也不是安装器**。[环境与字节记录](../../.scratch/mygo-efficiency-20261114/environment.json#L15-L20) [构建日志](../../.scratch/mygo-efficiency-20261114/mygo-probe/mygo-complete-full-debug-cold.log#L23-L29)
- 本轮没有测 A 的功能等价 debug / release 包大小，因此不提供 A/B 包体比值。
- 本轮没有启动任何 app，故 A/B/C 的冷启动、首帧、空闲内存、50 节点内存全部未知。

### 5.2 项目已有记录为什么不能直接比较

- A 的已有记录是 release 服务端在 12 人小型夹具压测下峰值工作集 **13.95 MiB**，明确不包含浏览器、Gitea、new-api 等进程；它不是桌面全进程内存。[packaging/README.md](../../packaging/README.md#L159-L167)
- C 的历史记录是 **0.2.0、Apple M1 Max、macOS**：单次空闲 RSS 约 225 MB、50 节点约 348 MB、`.app` 5.9 MB、zip 2.9 MB；同页 Windows 行全部待实测。它不是 C v0.3.2 的 Windows 数据，更不是 A/B 数据。[performance-macos.md](../../docs/release/performance-macos.md#L25-L51)
- MyGo README 的「single Go binary of a few megabytes / low memory」是项目描述，不是功能等价 Kacha 的测量报告。[MyGo README](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/README.md#L24-L40)

**结论**：包体 / 启动 / 内存当前没有可判定胜负的同口径证据。任何「MyGo 一定更小、更快启动、更省内存」的结论都超出本次数据。

---

## 6. 自动更新链

### 6.1 A：当前 Web 是运维替换，不是桌面粉发更新

当前 README 明确没有自动更新与桌面安装包；Windows 服务升级流程是停止服务、等待排空、替换程序与 `static/`、再启动。[README](../../README.md#L5-L10) [服务升级步骤](../../packaging/README.md#L77-L84)

因此 A 与 B 的「自动更新效率」不是同一发布形态；如果回到本地桌面，需要重新建立桌面粉发链，而不是恢复当前 Web 的脚本即可。

### 6.2 B：官方链完整，但要适配既有策略与 Gitea

MyGo 官方支持：

- 构建时签名，app 下载后以内置公钥验签并替换；feed 可来自 GitHub 或 HTTPS server。[Auto-updates](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/updates.md#L1-L61)
- 每个平台 manifest、update archive 与 delta；默认尝试最近 3 个版本的 delta，失败回退完整 archive。[Build / publish](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/updates.md#L63-L113) [Delta updates](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/updates.md#L175-L209)
- `mygo.Updater.Check`、`Install`、`App.Relaunch` 可自建 UI；Windows 替换安装目录文件，新版在 relaunch 或下次启动运行。[Custom update UI](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/updates.md#L228-L279)
- updater plugin 默认启动 10 秒后检查、之后每日一次，并提供可选的后台自动下载安装。[Updater plugin](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/plugins/updater.md#L31-L45)

**与既有桌面策略的差异**：旧 ADR 是启动 3 秒后、每 6 小时检查；后台只下载，用户点击才安装 / 重启，并要求任务队列与保存保护。[ADR 0016](../../docs/adr/0016-auto-update-downloads-in-background-and-restarts-on-user-action.md#L3-L13) 当前方向改为默认闲时自动更新；不能直接采用 plugin 的默认闲时判断代替 Kacha 的业务条件，需用 `mygo.Updater` 自建或包装流程，任务与保存保护仍是 Kacha 自己的责任。

**分发兼容未知**：C 的 Gitea updater 曾显式允许可信内网 HTTP 并强制 minisign 签名；MyGo 文档的自定义 feed 写 HTTPS，GitHub 是一等集成。[ADR 0017](../../docs/adr/0017-tauri-official-updater-for-desktop-updates.md#L1-L7) [MyGo feed](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/updates.md#L39-L61) **现有 Gitea / HTTP / Tauri manifest 与密钥能否无缝迁移未知**，不得假设兼容；应通过自定义 source 或改为受支持 HTTPS 发布流程专项验证。[Custom source](https://github.com/egoist/mygo/blob/46c97276cd5390884e17695ac830896add909c4f/docs/updates.md#L283-L336)

本轮没有构建签名更新包、没有上传、没有安装或重启，故 MyGo 更新链只有文档证据，没有 Kacha 实测。

---

## 7. 建议的决策路径

### 7.1 不建议的做法

- 不用最小壳 19.022s / 1.189s 直接推算全业务收益。
- 不为了「Go 编译快」立即重写全部 6,929 行服务端产品代码与 4,076 行集成测试。
- 不把 MyGo + Rust sidecar 写成纯 Go、单工具链或无条件交叉编译。
- 不把同一 React 的 Vite 构建成功写成桌面运行时迁移成功。
- 不用 C 的 macOS 0.2.0 数字代替 A/B Windows 数据。

### 7.2 建议先做两个相互对照的 spike

**Spike 1：MyGo + Rust sidecar，验证最小迁移路径**

1. 固定 MyGo 版本（优先正式 tag，或明确固定本报告的 `46c9727`），同时固定 CLI 与 automation CLI。
2. 复用当前 React 与 Rust server，验证 loopback 访问控制、进程退出、单用户数据根与凭据迁移。
3. 跑大画板包导入导出、缩略图、取消、进度、冲突保存与 Windows 路径测试。
4. 记录 Rust 业务改动是否仍是主要等待；若是，sidecar 不能解决核心编译诉求。

**Spike 2：选择一个真实业务切片做全 Go，验证收益而非玩具壳**

1. 选择同时含普通文件状态与大文件流的切片，例如 `store/fs` 加一条 `board_pack` 路径；当前模块边界见[服务端源码](../../server/src/lib.rs#L234-L281)。
2. 移植对应 Rust 测试为 Go 测试或 HTTP 合同测试，保持同一夹具与断言。
3. 绑定一个真实 struct、一个错误、一个大字节流与一个进度事件，测量生成、Go 编译和前端类型检查完整闭环。
4. 使用第 8 节基准重新测 cold / no-op / 增量；此时才可讨论「真实业务 Go 移植是否更快」。

**决策门槛**：只有当真实切片的构建收益、测试可维护性、Windows 行为和更新链都可接受时，才扩大全 Go 移植；否则保留 sidecar 或重新评估桌面壳分工。该建议是基于当前证据的工程判断，不是已完成的迁移结论。

---

## 8. 可复现基准与后续补测方案

### 8.1 复跑本轮命令

- A 的完整脚本：[benchmark-complete.ps1](../../.scratch/mygo-efficiency-20261114/benchmark/benchmark-complete.ps1#L1-L53)。
- B 的完整脚本：[benchmark-mygo-complete.ps1](../../.scratch/mygo-efficiency-20261114/mygo-probe/benchmark-mygo-complete.ps1#L1-L49)。
- A 原始结果：[results-complete.json](../../.scratch/mygo-efficiency-20261114/benchmark/results-complete.json#L1-L79)。
- B 原始结果：[results-mygo-complete.json](../../.scratch/mygo-efficiency-20261114/mygo-probe/results-mygo-complete.json#L1-L86)。

脚本中的 cold 目录会断言不存在，以防把 warm 当 cold。**复跑时复制为新的 scratch 探针并使用新目录名，不删除或清空已有缓存。** Go module 下载与 CLI 安装属于准备阶段，不计入 measured cold；Rust / Go dependency cache 是否保留必须写入结果。

### 8.2 功能等价后必须统一的口径

| 项目 | 统一方法 |
|---|---|
| cold native | A 使用全新 `CARGO_TARGET_DIR`；B 使用全新 `GOCACHE`。两者 dependency source cache 状态一致，记录是否有网络下载。 |
| warm no-op | 相同命令、相同源码、相同 cache，立即重复；同时单独记录 CLI 是否仍执行 codegen / frontend。 |
| incremental | 在等价业务层做同一语义小改动，不只改 main；各测至少 5 次，保留全部原始值与中位数。 |
| 前端 | A/B 使用同一 commit、同一 Vite flags、同一 Node；typecheck 是否进入全链必须一致。 |
| binding 改动 | 从保存 Go API 到生成 TS、typecheck、native build、窗口可用分别计时，不能只测 `go build`。 |
| HMR | 从保存 TSX 到 WebView2 页面提交更新；A 浏览器与 B WebView2 分开记录，不能用 Vite bundle 代替。 |
| 测试 / 调试 | 同一功能切片的 unit / integration 通过数、失败定位步骤、桌面 inspector / trace 是否可用；e2e 需另行授权。 |
| 包体 | 后续明确获准 release 后，比较功能等价的安装目录总字节、安装器字节与更新包字节；debug 探针不纳入 release 结论。 |
| 冷启动 / 内存 | 沿用项目已有的 5 次测量思想；Windows 统计 app 与其 WebView2 / helper 全部相关进程，同一画板、同一图片夹具。[既有测量方法](../../docs/release/performance-macos.md#L7-L23) |
| 自动更新 | 用隔离测试 feed 与测试安装目录验证签名、篡改拒绝、delta fallback、闲时判定、取消自动重启、任务保护、保存恢复；不发布真实 Release。 |

每次记录 commit、工具链、机器、电源 / 负载、命令、工作目录、cache 定义、开始 / 结束时间、退出码和原始日志。缺一项就标未知，不补估计值。

---

## 9. 最终判断

- **前端效率**：B 大概率保留 A 的 Vite / React 优势；构建复用已验证，HMR 体验未实测。
- **原生效率**：最小 MyGo 壳的 cold / 增量数字很有吸引力，但全业务等价证据不足；全链还存在绑定生成与前端重建成本。
- **工程效率**：MyGo typed binding、单命令 dev、打包与 updater 是明确功能收益；其成本是 Go 工具链升级、业务移植、桌面 e2e 重建、快速版本演进与既有 Gitea 链适配。
- **迁移策略**：先用 sidecar 降低功能风险，同时用真实 Go 业务切片验证编译收益；不要直接把最小壳结果当成全量重写依据。
- **C 的位置**：历史 Tauri 2 可用来理解 Rust 桌面壳、更新与既有性能口径，但本轮没有给它计时，也没有把它混进 A/B。

本报告支持「继续验证 MyGo」，不支持「现在已经证明 MyGo 全栈开发效率更高」。
