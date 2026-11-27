# Kacha 桌面构建与验证

Kacha 是单机优先的 Windows 桌面客户端：MyGo / Go 提供本机文件、系统剪贴板与窗口，React 画板嵌进可执行文件。普通查看、编辑与组织画板不依赖服务端。版本只在仓库根的 `mygo.config.ts` 声明。

## 构建

开发机使用原生 Windows、PowerShell、Python 3.11+、Node 24 与 `go.mod` 声明的 Go 工具链。MyGo 和 CLI 固定在 `go.mod` 的 v0.9.0；升级应独立验证原生剪贴板、窗口、文件协议与画板包导入。

日常验证使用 debug 构建：

~~~powershell
python packaging\build_desktop.py --debug
# 已按 lockfile 安装前端依赖时：
python packaging\build_desktop.py --debug --skip-install
~~~

输出为 `build/debug/windows-amd64/Kacha.exe` 与 `build-info.json`。debug 保留开发检查能力，使用独立目录，不覆盖正式交付产物。

正式交付才构建 release：

~~~powershell
python packaging\build_desktop.py
~~~

输出为 `build/windows-amd64/Kacha.exe`、MyGo 当前用户 NSIS 安装器 `kacha-setup-<版本>-amd64.exe` 与 `build-info.json`。debug 仍用 `-skip-installer`，不生成安装器。发布构建不上传 Release；签名密钥配对检查、Gitea 发布与更新描述门禁见 [安装器与发布链](RELEASE_163.md) 和 [可信自动更新与安全重启安装](RELEASE_164.md)。`build-info.json` 记录应用版本、profile、MyGo / Go / WebView2 版本、安装器与产物路径。WebView2 Runtime 版本读不到时记 null。

两个 profile 都先检查版本与更新说明：`mygo.config.ts` 是唯一产品版本源；`docs/release/changelog.md` 必须包含与它同号的一级标题，且该节「新增 / 改进 / 修复」至少一组下有条目。当前版本在最前，历史版本可查并保留当时语境，历史恢复来源见 `docs/release/changelog-sources.md`；完整索引与弹窗可见范围由前端守护测试检查。检查失败即退出，不运行构建命令。MyGo CLI 随后执行配置中的前端 `buildCommand`，再将 `client/dist` 嵌入程序；Go 模块位于仓库根，源码入口为 `./desktop`。

## 反馈直连与发布资产（#260）

反馈保留本机 Gitea OAuth2 + PKCE 一键授权，token 由 Windows DPAPI 保护，React 页面只读取授权状态。发送时桌面 Go 服务读取本机 token，直接向 `http://lzxsvn:3000` 的 `qinyuanj/kacha-feedback` 创建 issue、上传附件并回写链接，不再经过 `lzxsvn:3005` 或任何远端应用中继。

debug/release 都不再构建 `feedbackrelay.exe`，发布资产只包含桌面安装器、更新签名、更新描述与 `SHA256SUMS`。中继部署脚本、nssm 环境与中继地址设置已移除；旧设置中的 `feedback_relay_url` 在读取时丢弃。真实 token、密码、凭据文件不写入仓库、更新说明、测试夹具或客户端产物。

## 本机数据与迁入

首次启动在 `%AppData%\Kacha\data` 创建本机数据根，位置记录在 `%AppData%\Kacha\shell-state.json`。以后回到同一份数据；重复启动只激活已有窗口。数据由客户端管理，不按 API 密钥分用户。

数据迁入只通过用户手工选择的 `.ugcpack` 画板包，不扫描旧服务端、不迁移整用户、不对账。导入由本机 Go 服务检查、解压与合并，限制在数据根内。已有画板、任务记录、结果与图层兼容夹具用于验证文件交换；它们的格式号不随产品版本变化。

当前桌面已接通单份文生图：经桌面端口与本机服务调用团队网关，结果和任务记录落在任务目录。本机存储按任务目录与独立图片度量每块画板的体量（#158），画板列表照旧显示这个字节数；阶段、定稿、整理模式与体量提醒已在 1.7.0 移除，画板上不再有对应入口（[ADR 0028](../docs/adr/0028-remove-stages-finalize-and-tidy.md)）；尚未实现的能力保持明确不可用，不能因共享前端已有领域逻辑就认为这些能力已交付。归档与取消归档已由本机 Go 服务执行（20 个可编辑画板位、只读与版本冲突保护）。本机用量统计、未引用清理与回收恢复已通过桌面壳的 Usage 服务接通真实数据根；它按本机文件字节计量，不表示 token 或金额配额。画板包导出与完整结果保存已由本机 Pack 服务接通（#160）。其余原生剪贴板、保存、导入与文件访问的边界应以桌面端口能力和测试为准。

脱敏诊断包导出经本机 Go 服务完成：允许清单限定采集项（版本、平台、运行状态、脱敏日志），凭据只报存在与否，API 密钥、鉴权头与凭据文件不进入日志、诊断包或包内文件名，画板内容与任务目录不打包。取消、目标不可写与采集失败都有各自明确的结局，不留半成品，也不改动本机创作数据。

## 验证

### 验证前的依赖准备

`verify.py` 启动时先比对 `client/package-lock.json` 与 `client/node_modules/.package-lock.json`：`node_modules` 缺失、lockfile 声明了但没装、已装版本与 lockfile 不同，都判定为依赖未准备就绪。此时只打印原因与修复命令 `npm --prefix client ci`，并在跑任何命令前退出，不把环境问题报成类型错误或死代码。`optional` 的平台专属二进制（如各平台的 `@oxc-parser/binding-*`）按平台选择性安装，缺失不算不一致。

检查只读这两个文件、不调用 npm，通常十几毫秒；依赖完整时验证行为不变。`node_modules` 是空目录或安装被中断时不会有安装记录，同样按未准备就绪处理，重新 `npm ci` 即可。

~~~powershell
npm --prefix client ci
python packaging\verify.py --preflight
python packaging\verify.py
# 合入集成分支前的发版门禁（CRAP + 重复检查，不含变异测试）：
python packaging\verify.py --quality
# 显式指定质量比较基线：
python packaging\verify.py --base origin/main
~~~

验证按两阶段执行，最后按稳定顺序汇总每项状态与耗时，任一失败即返回非零：

- **Phase 1（快速失败 + 内存隔离，同步顺序执行）**：`typecheck` → `lint:dead`（knip 普通与 production）。数秒内反馈类型或死代码错误，并把 `knip` 瞬时内存峰值与后续重负载彻底隔开（守住 ADR 0020 的 23,060 MB 红线）。
- **Phase 2（受控并发，`max_workers=2`）**：分 2 条错峰链并行执行：
  - 链 A：前端单测（产出 LCOV 覆盖率到 `client/target/coverage`）→ `quality.py --use-existing-coverage`（复用刚产出的覆盖率，不再重跑前端单测；若前端单测失败则不跑质量门禁，并在汇总中明确标为「未运行（前置失败）」，绝不静默通过）。
  - 链 B：打包脚本单测（`unittest discover -s packaging/tests`，先与前端单测错峰执行以避开 Go 满核编译争用）→ `go test ./...` → `go test -race ./desktop/internal/diagnostics/...` → 桌面 debug 构建。

`-race` 那一步只覆盖诊断导出与日志记录的并发安全（#229 的并发证据），定向到 `desktop/internal/diagnostics` 一个包：整仓跑 `-race` 太慢，本机内存也有限。`-race` 需要 cgo，所以执行前先看工具链（`CGO_ENABLED=1` 且 `go env CC` 指名的编译器在 PATH 上）：有工具链就真跑，没有就打印「未运行 -race」并在汇总里标成未运行——只说明未运行，不静默跳过，也不因此判定失败。本机 Windows 只装了 Go、没有 gcc，因此这里通常看到的是「未运行」；CI 的 `windows-latest` 自带 MinGW，会真正执行。不会安装 Chromium，也不运行 e2e。旧的 --e2e 参数会被拒绝。`--quality` 只标注「这是发版门禁用例」：它跑的质量步骤与默认验证相同，不再追加变异测试（见下文「变异测试未启用」）。

Go 单测覆盖本地存储、路径边界、导入、剪贴板契约与服务绑定；前端单测使用壳端口替身。它们不能替代 Windows 已解锁交互会话里的真实剪贴板、外部软件粘贴、窗口激活与打包产物检查。debug 构建只证明程序可构建，不宣称这些交互验收通过。完整验证顺序与质量门禁前置条件见 [verify.py](verify.py) 的 `commands()` 与依赖预检；`--quality` 默认比较当前分支与目标分支的 merge-base，目标引用缺失或历史不足会失败。

非 Draft PR 的 Windows CI 使用同一 `verify.py` 入口（不带 `--quality`，但质量步骤相同），质量基线为 PR 的实际目标分支；目标引用缺失、历史不足或没有共同祖先会失败。PR 更新取消过期运行，直接 push 不触发该 workflow。CI 与本机门禁都不运行 mutator。PR CI 在本机门禁之外，另在同一 workflow 里安装 Playwright Chromium 并单独跑一遍 `npm --prefix client run e2e`（见 `.github/workflows/pr-verification.yml`）；本机 `python packaging\verify.py` 不跑 e2e。

### Windows 完整性标签

输出目录若继承 Low 完整性标签，程序可能无法写临时文件或创建符号链接。`--preflight` 只检查 build、`client/target` 与前端依赖，发现问题只报告命令，不修改目录。在确认目标目录后用 PowerShell 修复：

~~~powershell
icacls build /setintegritylevel '(OI)(CI)M'
icacls client\target /setintegritylevel '(OI)(CI)M'
~~~

输出目录尚不存在时，先创建目录再设置标签。Go 测试还使用系统临时目录与 Go 缓存；这些位置的权限问题不在仓库预检范围内。

## 前端质量门禁

`packaging/quality.py` 只测 `uml-quality.json` 中声明的 `client/src` TypeScript / TSX。默认比较 `origin/main` 的 merge-base 以来的改动（含未提交与未跟踪源码），`--base` 可换基线；`--use-existing-coverage` 供 `verify.py` 复用前端单测已产出的 LCOV 覆盖率报告（默认关闭，直接运行 `quality.py` 行为不变）。CRAP 超过 10、CRAP 覆盖率缺失、改动文件涉及相似度至少 0.8 的重复配对都会失败。`--mutate` 仍是可选开关，会额外拒绝存活与未覆盖变异点，但 `verify.py` 不再传它，当前没有调用方（见下文「变异测试未启用」）。

**Go 的 CRAP、DRY 与 mutation 尚未接入。** 当前 Go 验证为 `go test ./...`，不能声称整个桌面客户端通过这三项质量指标。架构图示例也只声明前端 TypeScript，不伪造 Go 图或覆盖率。

工具是单一 uml-viewer 二进制的 crap / dry / mutate 子命令。先查 `UML_VIEWER_BIN` 指向的文件，再查 DSH 插件 `%USERPROFILE%\.dsh\dsh-uml-viewer\current.json` 记录的版本目录；找不到即失败。前端覆盖率、变异副本与指标落在 `client/target`、`client/.metrics`。变异副本补复制 `../contracts`、`../docs/release` 与 `../mygo.config.ts`；工具必须支持 `--copy`。

PR CI 从 npm 官方 registry 取得固定 `@dsh-uml-viewer/win32-x64@1.0.0`，核对 SHA-512 后只解出可执行文件，通过 `UML_VIEWER_BIN` 传入。该固定版本不支持 mutator 的 `--copy`，仅用于默认 CRAP 与 DRY。

### 变异测试未启用

2026-11-20 owner 决定不做变异测试，发版门禁因此**不含变异测试**：`verify.py --quality` 与默认验证都只跑 CRAP 与重复检查。`packaging/quality.py` 每次运行都打印一行「变异测试未启用」并给出原因，不静默跳过——静默会让人以为跑过了。

两条原因各自都足以让这条路走不通：

- 本机 Windows commit limit 只有 23,060 MB（物理内存 16 GB 加 6.8 GB pagefile），`--mutate` 的变异工作副本会把整机拖崩。
- uml-viewer 当前构建的 mutator 产不出覆盖率产物，所有变异体都被算成未覆盖，判定没有区分度（#184 因此关闭）。

后果 owner 已知情并接受：改了逻辑却没补测试，此后只能靠人和复审兜。

能力没有删。`packaging/quality.py` 的 mutator 代码（`mutation_command`、`mutation_uncovered`、`--mutate` 与 `--copy` 前置检查）与相应单测都保留，只是当前没有调用方。要重新启用，至少同时满足：本机内存与 commit limit 够跑变异工作副本、mutator 能产出可信的覆盖率产物、owner 重新确认这两条前提；届时在 `verify.py` 的 `commands()` 里重新拼上 `--mutate`，并把本节与 ADR 0020、0022 改回一致。判定逻辑（存活变异体、未覆盖变异点）不需要改。

## 首日验收记录

首日验收（#165）及其后续自主 e2e / 真机结论见 [发行验收记录](../docs/release/ACCEPTANCE-165.md)，包括外部阻塞与证据边界；不要以构建成功或回放替代真实网关与真机安装。
