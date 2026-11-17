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

输出为 `build/windows-amd64/Kacha.exe`、MyGo 当前用户 NSIS 安装器 `kacha-setup-<版本>-amd64.exe` 与 `build-info.json`。debug 仍用 `-skip-installer`，不生成安装器。发布构建不上传 Release；签名、Gitea 发布与更新描述门禁见 [安装器与发布链](RELEASE_163.md)。`build-info.json` 记录应用版本、profile、MyGo / Go / WebView2 版本、安装器与产物路径。WebView2 Runtime 版本读不到时记 null。

两个 profile 都先检查版本与更新说明：`mygo.config.ts` 是唯一产品版本源；`docs/release/changelog.md` 必须包含与它同号的一级标题，且该节「新增 / 改进 / 修复」至少一组下有条目。当前版本在最前，历史版本可查并保留当时语境，历史恢复来源见 `docs/release/changelog-sources.md`；完整索引与弹窗可见范围由前端守护测试检查。检查失败即退出，不运行构建命令。MyGo CLI 随后执行配置中的前端 `buildCommand`，再将 `client/dist` 嵌入程序；Go 模块位于仓库根，源码入口为 `./desktop`。

## 本机数据与迁入

首次启动在 `%AppData%\Kacha\data` 创建本机数据根，位置记录在 `%AppData%\Kacha\shell-state.json`。以后回到同一份数据；重复启动只激活已有窗口。数据由客户端管理，不按 API 密钥分用户。

数据迁入只通过用户手工选择的 `.ugcpack` 画板包，不扫描旧服务端、不迁移整用户、不对账。导入由本机 Go 服务检查、解压与合并，限制在数据根内。已有画板、任务记录、结果与图层兼容夹具用于验证文件交换；它们的格式号不随产品版本变化。

当前桌面已接通单份文生图：经桌面端口与本机服务调用团队网关，结果和任务记录落在任务目录；尚未实现的整理等能力保持明确不可用，不能因共享前端已有领域逻辑就认为这些能力已交付。归档与取消归档已由本机 Go 服务执行（20 个可编辑画板位、只读与版本冲突保护）。本机用量统计、未引用清理与回收恢复已通过桌面壳的 Usage 服务接通真实数据根；它按本机文件字节计量，不表示 token 或金额配额。画板包导出与完整结果保存已由本机 Pack 服务接通（#160）。其余原生剪贴板、保存、导入与文件访问的边界应以桌面端口能力和测试为准。

脱敏诊断包导出经本机 Go 服务完成：允许清单限定采集项（版本、平台、运行状态、脱敏日志），凭据只报存在与否，API 密钥、鉴权头与凭据文件不进入日志、诊断包或包内文件名，画板内容与任务目录不打包。取消、目标不可写与采集失败都有各自明确的结局，不留半成品，也不改动本机创作数据。

## 验证

先安装锁定的前端依赖，然后运行：

~~~powershell
npm --prefix client ci
python packaging\verify.py --preflight
python packaging\verify.py
# 合入集成分支前加前端变异测试：
python packaging\verify.py --quality
# 显式指定质量比较基线：
python packaging\verify.py --base origin/main
~~~

默认按顺序运行打包脚本单测、前端单测、类型检查、knip（普通与 production）、`go test ./...`、桌面 debug 构建和前端质量门禁。各项跑完再汇总，任一失败即返回非零。不会安装 Chromium，也不运行 e2e。旧的 --e2e 参数会被拒绝。

Go 单测覆盖本地存储、路径边界、导入、剪贴板契约与服务绑定；前端单测使用壳端口替身。它们不能替代 Windows 已解锁交互会话里的真实剪贴板、外部软件粘贴、窗口激活与打包产物检查。debug 构建只证明程序可构建，不宣称这些交互验收通过。

非 Draft PR 的 Windows CI 使用同一 `verify.py` 入口，质量基线为 PR 的实际目标分支；目标引用缺失、历史不足或没有共同祖先会失败。PR 更新取消过期运行，直接 push 不触发该 workflow。CI 不运行 mutator，合入前仍需手动 `--quality`。

### Windows 完整性标签

输出目录若继承 Low 完整性标签，程序可能无法写临时文件或创建符号链接。`--preflight` 只检查 build 与 `client/target`，发现问题只报告命令，不修改目录。在确认目标目录后用 PowerShell 修复：

~~~powershell
icacls build /setintegritylevel '(OI)(CI)M'
icacls client\target /setintegritylevel '(OI)(CI)M'
~~~

输出目录尚不存在时，先创建目录再设置标签。Go 测试还使用系统临时目录与 Go 缓存；这些位置的权限问题不在仓库预检范围内。

## 前端质量门禁

`packaging/quality.py` 只测 `uml-quality.json` 中声明的 `client/src` TypeScript / TSX。默认比较 `origin/main` 的 merge-base 以来的改动（含未提交与未跟踪源码），`--base` 可换基线。CRAP 超过 10、CRAP 覆盖率缺失、改动文件涉及相似度至少 0.8 的重复配对都会失败；`--mutate` 额外拒绝存活与未覆盖变异点。

**Go 的 CRAP、DRY 与 mutation 尚未接入。** 当前 Go 验证为 `go test ./...`，不能声称整个桌面客户端通过这三项质量指标。架构图示例也只声明前端 TypeScript，不伪造 Go 图或覆盖率。

工具是单一 uml-viewer 二进制的 crap / dry / mutate 子命令。先查 `UML_VIEWER_BIN` 指向的文件，再查 DSH 插件 `%USERPROFILE%\.dsh\dsh-uml-viewer\current.json` 记录的版本目录；找不到即失败。前端覆盖率、变异副本与指标落在 `client/target`、`client/.metrics`。变异副本补复制 `../contracts`、`../docs/release` 与 `../mygo.config.ts`；工具必须支持 `--copy`。

PR CI 从 npm 官方 registry 取得固定 `@dsh-uml-viewer/win32-x64@1.0.0`，核对 SHA-512 后只解出可执行文件，通过 `UML_VIEWER_BIN` 传入。该固定版本不支持 mutator 的 `--copy`，仅用于默认 CRAP 与 DRY。