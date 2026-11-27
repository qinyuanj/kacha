# 首日整体验收记录（#165）

> 验收对象：spec [#150](https://github.com/qinyuanj/kacha/issues/150) 的收口票 [#165](https://github.com/qinyuanj/kacha/issues/165)。
> 验收角色：验收子代理 `accept-165`（implement-spec 的 implementer 角色）。
> 代码基线：`spec-150/desktop-parity-day1` @ `76b9fcb`（#151–#164 已合入集成分支）。
> 验收时间：2026-11-17（Asia/Shanghai）。
> 运行环境：Windows x64；Python 3.12.10；Node 24 + Vitest 5.0.1；Go 1.27.3；MyGo 0.9.0；WebView2 158.0.4370.26。
> 2026-11-21 结清：owner 确认真实网关、正式发行、双版本升级、人工交互等外部项均已验收，Issue #165 已关闭。以下正文保留 2026-11-17 当时的基线与证据，表格中的「阻塞」是写下时的结论，不是当前状态。

## 1. 结论（2026-11-17 当时）

| 验收面 | 结论 | 依据 |
| --- | --- | --- |
| 可自动化的首日验收 | **通过** | 完整 `python packaging\verify.py` 7/7 通过；release 构建产出安装器与 build-info；两版本隔离测试发行的元数据、选版、验签与拒篡改通过 |
| 真实网关（文生图 / 参考图编辑） | **阻塞** | 本机没有网关地址与 API 密钥；全规格 5 个生成任务的预算已用 **0** |
| 正式签名发布 | **阻塞** | 没有 `GITEA_TOKEN`；本机签名密钥不是 MyGo Ed25519 私钥；构建没有内置发布者公钥 |
| 双版本真机安装升级 | **阻塞** | 没有可由代理操作的人工交互会话去点选安装、放行 SmartScreen、重启并核对版本与数据 |
| SmartScreen / Authenticode 人工观察 | **阻塞** | 安装器 `NotSigned`，需人工在首次运行时观察系统提示 |
| 票 #165 是否可关闭 | **否** | 上述外部条件与人工证据未齐；本记录不构成发布 |

本记录把五类证据分开记，不互相冒充：**自动测试**、**构建产物**、**隔离测试发行**（用测试密钥签的临时资产，不是正式发布）、**受控网关替身**（httptest / node:http，不是真实网关）、**人工交互**（未执行）。合成回放不当作真实网关成功，测试签名不当作正式发布。

## 2. 证据类型

| 代号 | 含义 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| A 自动测试 | 仓库内单元 / 集成测试，经 `python packaging\verify.py` 或定向命令跑通 | 领域规则、端口接线、Go 服务在临时数据根上的真实文件行为 | 真实网关、真实安装、真实剪贴板互操作 |
| B 构建产物 | 真实构建出的 `Kacha.exe`、安装器、`build-info.json` 与 SHA-256 | 可构建、可取得安装包、构建记录完整 | 已发布、已签名、已安装 |
| C 隔离测试发行 | 临时目录里 `go tool mygo keygen` 测试密钥 + `tools/signrelease` 签出的两版本资产 | 发布元数据一致、客户端选版 / 验签 / 拒篡改 / 安装入口 | 正式发布者身份、真机安装升级 |
| D 受控网关替身 | `httptest`（Go）与 `node:http`（前端）替身跑主流程 | 配置、参考图、提交、结果落盘、重开与错误分类的接线 | 真实网关可达、真实模型出图 |
| E 真实网关 | 团队 new-api 网关的实际生成调用（本轮未执行） | 真实生成、真实计费与真实错误响应 | — |
| F 人工交互 | 已解锁 Windows 会话里由人完成的安装、升级、剪贴板互操作、SmartScreen 放行 | 首日安装更新与原生互操作的最终证据 | — |

## 3. 验收项映射

### 3.1 规格 Testing Decisions（15 条）

规格 [#150](https://github.com/qinyuanj/kacha/issues/150) 的 Testing Decisions 共 15 条，逐条对应证据如下。

| # | 规格要求（摘要） | 证据类型 | 具体命令 / 文件 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 按完整用户流程验收是最高边界：经真实壳端口与本机服务，以可见状态、实际文件、可重开数据、可启动程序判定 | A + B + C；F 未执行 | §4.1–§4.3；`build/windows-amd64/kacha-setup-1.5.0-amd64.exe` | **部分通过**：桌面端口 / Go 服务 / 构建 / 隔离发行已验证；真机安装与原生交互未执行 |
| 2 | 优先扩展现有桌面端口集成测试、运行器测试与 Go 服务临时目录测试 | A | `python packaging\verify.py`（171 个前端测试文件、25 个 Go 包） | **通过** |
| 3 | 同一桌面端口入口下，用受控网关替身与真实临时文件系统覆盖 配置→参考图→提交→结果落盘→保存→重开；跨语言接线要有实际绑定 / 服务集成证据 | D + A | `npm --prefix client test -- src/shell/desktopGeneration.test.ts src/shell/desktopImageEdit.test.ts`（2 个文件 / 5 个用例）；`go test ./desktop/internal/gateway -v`（10 个用例）。图层拆分与跨画板队列 / 份数覆盖随 #234 归并到 `src/core/runner.test.ts`、`src/core/submission.test.ts`、`src/ui/previewLayers.test.ts`、`src/core/layerCount.test.ts`（见 #4 / #5 行证据） | **替身通过**；真实网关 E 未执行 |
| 4 | 生成回归：发送计划与任务记录一致、模型参数边界、份数与逐份取消、跨画板并发、401/429/5xx、错误响应、下载失败、部分图层失败、结局落盘与重开 | A | 同 #3；`src/core/runner.test.ts`、`src/core/run.test.ts`、`src/core/submission.test.ts`、`src/core/taskDir.test.ts`、`src/shell/desktopGeneration.test.ts` 等 | **通过（替身）**；真实网关未执行 |
| 5 | 归档与存储：满 20 位、归档释放位置、取消归档限制、阶段与定稿整理、唯一引用计量、容量提醒不阻止生成、归档引用不被误清理 | A | `go test ./desktop/internal/localstore ./desktop/internal/boardmeasure ./desktop/internal/usageservice`；`src/shell/desktopBoards.test.ts`、`src/core/tidy.test.ts`、`src/ui/stages.test.ts`、`src/ui/UsageSection.test.ts` | **通过** |
| 6 | 清理 / 恢复：预览取消零修改、未引用判定、不可读画板阻断、回收区 14 天边界、恢复冲突不覆盖、失败可追溯 | A | `go test ./desktop/internal/usageservice`（5 个用例）；`src/ui/usageClean.test.ts`、`src/ui/UsageSection.test.ts` | **通过** |
| 7 | 文件交换与结果保存：旧包读取、导出再导入、图片 / 图层 / 任务记录完整、去重、冲突、损坏与越界拒绝、取消与失败保护；结果保存以实际输出文件可读为判据 | A | `go test ./desktop/internal/packimport ./desktop/internal/packexport ./desktop/internal/resultsave`（13 + 5 + 6 个用例）；`src/shell/desktopPackImport.test.ts`、`src/shell/desktopPackExport.test.ts`、`src/ui/BoardPackDialog.test.ts` | **通过** |
| 8 | 数据位置迁移：成功重启、失败回退、目标冲突与路径边界；凭据覆盖重启读取、替换、清除及诊断输出不含秘密 | A | `go test ./desktop/internal/moveroot ./desktop/internal/storage ./desktop/internal/gateway ./desktop/internal/diagnostics`；`src/shell/desktopDataRoot.test.ts`、`src/core/dataRoot.test.ts` | **通过** |
| 9 | 更新历史：保护全部恢复后的版本索引，弹窗显示当前及更早版本，未发布版本不误展示，格式与单一版本源门禁有效 | A | `src/core/changelog.test.ts`、`src/ui/ChangelogDialog.test.ts`；`python -m unittest discover -s packaging/tests`（含 `packaging/tests/test_release_gate.py`） | **通过** |
| 10 | 安装与更新：在已解锁 Windows x64 交互会话，用两个隔离测试版本执行首次安装→建立数据与凭据→发现更高版本→后台下载→点击更新→重启→验证版本与数据保留 | C 部分；F 未执行 | §4.3（资产与信任链） | **阻塞** |
| 11 | 更新故障：不完整 / 不匹配发行、latest 为 Web 包、错误 / 篡改签名、损坏下载、离线、安装失败、任务未完成、在途导入 / 导出、画板或界面状态保存失败 | A | `go test ./desktop/internal/updateservice`（15 个用例）；`src/core/updatePreparation.test.ts`、`src/core/updateScheduler.test.ts`、`src/ui/UpdateToolbarControl.test.tsx` | **通过（单元 / 替身）**；真机安装失败仍待 F |
| 12 | 更新的最高测试入口是公开的检查 / 准备 / 安装服务及实际安装器；若缺少只新增一个协调边界 | A + C | §4.3 的 `TestIsolatedReleaseAcceptance`：走 `Service.Check` / `Install`，安装器启动被注入记录（参数 `/S`），不真起进程 | **部分通过**：真实安装器启动与重启未执行 |
| 13 | 真实剪贴板复制 / 粘贴、外部软件互操作、窗口激活及真实安装更新单独记录人工 / 交互证据；不以 debug 构建或合成事件替代 | F 未执行 | `go test ./desktop/internal/clipboard`（契约层）只能证明端口形状 | **阻塞** |
| 14 | 按项目验证入口执行完整验证，合入前运行含质量检查的验证；保留前端质量门禁；不宣称 Go 的 CRAP / DRY / mutation 已通过 | A | `python packaging\verify.py`（含 `packaging/quality.py` 的 CRAP 与 DRY）；`--quality` / mutate 按项目与本次约定未运行 | **通过（默认门禁）**；变异测试未执行，不宣称通过 |
| 15 | 真实网关验收：最多 5 个生成任务，合成提示词 / 测试图片，执行前列明模型与任务分配，失败也计数、不追加，记录既有消耗；只按实际完成报告，不用回放冒充 | E 未执行 | 本机当时无网关配置、无任务记录 | **阻塞（0/5 已用）** |

> 2026-11-24 注记：本表第 5 行把「阶段与定稿整理」列为**通过**——写下时它确实通过（1.5.0 基线 `76b9fcb`）。1.7.0 起阶段、定稿与整理整套移除（[ADR 0028](../adr/0028-remove-stages-finalize-and-tidy.md)），该行证据里的 `src/core/tidy.test.ts`、`src/ui/stages.test.ts` 已随特性删除；原行保留不改，也不改判为失败。

### 3.2 票 #165 验收项（9 条）

| # | 验收项（摘要） | 证据类型 | 具体证据 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 真实网关前列明模型、合成载荷与任务分配；全范围最多 5 个生成任务，失败也计数、不追加重试，记录既有消耗 | E | 本机当时无网关配置、无任务记录 | **未执行（0/5 已用）** |
| 2 | 真实验证文生图、参考图编辑、结果落盘与重开；回放、真实成功与未完成分别记录 | D 通过；E 未执行 | §4.4（5 个前端用例 + 10 个 Go 用例） | **真实网关未执行** |
| 3 | 已解锁 Windows x64 交互会话，用两个隔离测试发行完成首次安装、建立数据与凭据、发现更高版本、后台下载、点击更新、重启、版本与数据保留 | C + F | §4.3 覆盖资产、选版、下载、验签与安装入口；安装、重启与数据保留未执行 | **阻塞（B3）** |
| 4 | 开始菜单、快捷方式选择、无需管理员权限及卸载默认保数据；旧 0.3.x 只承诺手动安装与画板包迁入；新壳后续版本必须可自动更新 | B + C + F | §4.2 安装器；§4.5 本机旧 0.3.0 安装 | **阻塞（B2、B3）** |
| 5 | 跨流程覆盖归档与满位、阶段与定稿、用量提醒不阻止生成、回收恢复、包往返、结果保存、数据迁移、诊断秘密排除 | A | 见 Testing Decisions #5–#8 的命令与用例 | **通过** |
| 6 | 联验任务未完成、参考图读取、退避、在途导入 / 导出 / 迁移、画板或界面状态保存失败及更新安装失败，证明保护有效、工作不丢失、旧版本仍可启动 | A | `src/core/updatePreparation.test.ts`、`src/core/runner.test.ts`、`go test ./desktop/internal/updateservice ./desktop/internal/storage ./desktop/internal/packservice` | **通过（单元 / 替身）** |
| 7 | 真实剪贴板复制 / 粘贴、外部软件互操作和窗口激活单独留交互证据，不以合成事件或 debug 构建替代 | F | 未执行；`desktop/internal/clipboard` 仅契约层 | **阻塞（B3）** |
| 8 | 运行项目完整验证，合入前完成含质量检查的验证；如实区分前端质量门禁与 Go 现有测试，不宣称未接入的 Go 指标 | A | §4.1；`--quality` / mutate 未运行（项目约定由用户手动触发） | **通过（默认门禁）**；变异未执行 |
| 9 | 按实际验收更新 1.5.0 说明与使用 / 构建文档；完成标准含可取得安装包、可验证签名、有效更新描述及双版本升级证据；缺凭据或交互环境明确标记阻塞 | B + C + 文档 | §4.2、§4.3；发布说明改为从 changelog.md 切出当前版本一节（ADR 0024 单一来源），并更新 README 与 packaging 文档 | **部分通过**：构建与隔离签名证据在；正式签名发布与双版本升级阻塞 |

> 2026-11-24 注记：本表第 5 行把「阶段与定稿」列为**通过**——写下时它确实通过（1.5.0 基线 `76b9fcb`）。1.7.0 起阶段与定稿整套移除（[ADR 0028](../adr/0028-remove-stages-finalize-and-tidy.md)），原行保留不改，也不改判为失败。

## 4. 本次实跑证据

### 4.1 完整验证（一次）

```powershell
python packaging\verify.py
```

结果：**7/7 通过，退出码 0**（2026-11-17 17:05–17:10）。完整日志在 `.scratch/spec-150/acceptance-165/verify.log`（该目录被 git 忽略，可用同样命令复跑）。

| 步骤 | 结果 | 关键数字 |
| --- | --- | --- |
| `python -m unittest discover -s packaging/tests` | 通过 | 120 个用例 |
| `npm --prefix client test` | 通过 | 171 个测试文件 / 2427 个用例 |
| `npm --prefix client run typecheck` | 通过 | — |
| `npm --prefix client run lint:dead` | 通过 | — |
| `go test ./...` | 通过 | 25 个包 ok，0 个 FAIL |
| `python packaging/build_desktop.py --debug --skip-install` | 通过 | `build/debug/windows-amd64/Kacha.exe`（1.5.0） |
| `python packaging/quality.py` | 通过 | CRAP 报告与 DRY 报告已写出；门禁退出码 0 |

三点说明：

- 预检没有报告仓库 `build/` 或 `client/target/` 的 Low 完整性标签问题。日志中出现的 Low 标签提示来自 `test_verify` 自己造的临时目录夹具，不是本次构建目录。
- `quality.py` 的 DRY 报告列出一对 `src/core/history.ts:73-76` 与 `78-81` 的重复（相似度 1.00）。这两个位置不在本次改动集内，按门禁规则属于存量，不拦合入；这里如实记录，不当作已消除。
- 术语表缺陷处置（#238 收口复核，本条已按 #227 复审必修 5 更正）：测试清理时 `a166588`（「清理术语表」）把 `GLOSSARY.md` 从 229 行、53 条砍到 45 行、12 条。当时登记的处置是「`5de3ad9` 最小化恢复「反馈」「反馈中继」两条并补回 token 归属表述，不再改动 `GLOSSARY.md`」——这条说法不成立：被删的 41 条里仍有大量在用的领域定义，而 `docs/agents/domain.md` 要求 agent 探索领域前先读这张词表，等于让词表失去作用。本轮按引用证据逐条核对（`grep` 代码 / 契约 / 文档，不计 `GLOSSARY.md` 自身）：41 条全部仍被引用，例如图层 84 个文件、归档画板 47、定稿 32、画板体量 26、并发上限 23、发送计划 16、用户序号 14、区域编号 11、结局记录 9、任务队列 8。据此把 41 条按原有格式（`**术语**：` + 定义 + `_Avoid_：`）恢复，词表回到 228 行、53 条；没有一条属于「产品已删除、确实无人引用」，所以一条都没有故意不恢复。原有 12 条保留 `a166588` 之后的新措辞（含 #214 的 token 归属表述），不回退到旧文本，避免把后续修正一并丢掉。恢复后 `python packaging/verify.py --preflight` 退出码 0，`packaging/tests/test_verify.py` 的 `test_the_real_repository_docs_pass_the_gate` 直接断言 `documentation_problems(ROOT) == []`；文档门禁照旧检查「反馈」「反馈中继」与 token 归属说明（用户自带、权限、服务端不持有统一写 token）。

### 4.2 release 构建产物（未发布）

```powershell
python packaging\build_desktop.py --skip-install
```

构建成功：MyGo 0.9.0 生成 `kacha-setup-1.5.0-amd64.exe`（当前用户 NSIS 安装器），并写出 `build-info.json`。没有调用 Gitea，没有覆盖 `release/` 下的历史资产。

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `build/windows-amd64/Kacha.exe` | 13,726,720 字节 | `cc7e355311d4d9767b72d0bad5c1c980c8a954f342d331b8b26ad4a0bf15129d` |
| `build/windows-amd64/kacha-setup-1.5.0-amd64.exe` | 4,342,005 字节 | `f266aa57f5aee2631a0a2e32eb0ee293310d9960eb89cbe647e36e78cf66472e` |
| `build/windows-amd64/build-info.json` | 287 字节 | `8f2ca0700a5555a3dab8c9a771c1be9e3ecbf8ac7600c1d2bba945c11356f3b3` |

`build-info.json` 记录：`version = 1.5.0`、`platform = windows/amd64`、`profile = release`、`mygo = 0.9.0`、`go = go1.27.3`、`webview2 = 158.0.4370.26`、`installer = build/windows-amd64/kacha-setup-1.5.0-amd64.exe`。

Windows 签名状态（`Get-AuthenticodeSignature`）：**NotSigned**，没有签名证书。按规格，首日接受未购 Authenticode 证书带来的 SmartScreen 提示；系统提示与放行必须人工观察。

另记一项观察（不是本次缺陷）：安装器文件的 VersionInfo（FileVersion / ProductVersion / FileDescription / CompanyName）为空；版本身份由文件名、`build-info.json` 与程序内 `Shell.Info.Version` 保证。若要按文件属性做运维核对，需要发布侧另加元数据。

### 4.3 两版本隔离测试发行：元数据、选版、验签、拒篡改

全部在临时目录完成：**没有写 `release/`、没有上传 Gitea、没有提交私钥**。测试密钥对由 `go tool mygo keygen` 生成，私钥只落在 `.scratch/`（被 `.gitignore` 忽略，`git check-ignore` 已核实）。

组装（本次在 MSYS / Git Bash 中执行；等价 PowerShell 命令用同样参数）：

```bash
W=.scratch/spec-150/acceptance-165/isolated-release
BASE=http://127.0.0.1:38991
mkdir -p "$W/keys" "$W/releases/1.5.0" "$W/releases/1.6.0"
go tool mygo keygen -o "$W/keys"
printf "# 1.5.0\n\n隔离测试发行的当前版本。\n" > "$W/notes-1.5.0.md"
printf "# 1.6.0\n\n隔离测试发行的更高版本。\n" > "$W/notes-1.6.0.md"
cp build/windows-amd64/kacha-setup-1.5.0-amd64.exe "$W/releases/1.5.0/kacha-setup-1.5.0-amd64.exe"
cp build/windows-amd64/kacha-setup-1.5.0-amd64.exe "$W/releases/1.6.0/kacha-setup-1.6.0-amd64.exe"
KEY=$(cat "$W/keys/mygo-update.key")
for v in 1.5.0 1.6.0; do
  MYGO_UPDATER_PRIVATE_KEY="$KEY" go run ./tools/signrelease \
    -installer "$W/releases/$v/kacha-setup-$v-amd64.exe" -version "$v" \
    -notes "$W/notes-$v.md" -base-url "$BASE" -out "$W/releases/$v"
  (cd "$W/releases/$v" && sha256sum "kacha-setup-$v-amd64.exe" "kacha-setup-$v-amd64.exe.sig" update-windows-amd64.json > SHA256SUMS)
done
```

元数据一致性（发布脚本的真实门禁函数，不是另写一套规则）：

```bash
python - "$W" <<PY
import sys
from pathlib import Path
sys.path.insert(0, "packaging")
from publish_release import collect_assets
root = Path(sys.argv[1])
for version in ("1.5.0", "1.6.0"):
    paths = collect_assets(root / "releases" / version, version)
    print("metadata OK", version, "->", ", ".join(p.name for p in paths))
PY
```

输出：

```text
metadata OK 1.5.0 -> kacha-setup-1.5.0-amd64.exe, kacha-setup-1.5.0-amd64.exe.sig, update-windows-amd64.json, SHA256SUMS
metadata OK 1.6.0 -> kacha-setup-1.6.0-amd64.exe, kacha-setup-1.6.0-amd64.exe.sig, update-windows-amd64.json, SHA256SUMS
```

发布门禁对**签名时写入的真实描述**再独立跑一遍（`collect_assets` 内部会用合成 URL 调 `validate_release_assets`，这里改用描述里的真实 URL 与平台）：

```bash
python - "$W" <<PY
import json, sys
from pathlib import Path
sys.path.insert(0, "packaging")
from release_gate import validate_release_assets
root = Path(sys.argv[1]) / "releases"
for version in ("1.5.0", "1.6.0"):
    manifest = json.loads((root / version / "update-windows-amd64.json").read_text(encoding="utf-8"))
    validate_release_assets(manifest, version)
    print("release_gate OK", version, manifest["platform"], manifest["url"])
PY
```

```text
release_gate OK 1.5.0 windows-amd64 http://127.0.0.1:38991/qinyuanj/kacha/releases/download/v1.5.0/kacha-setup-1.5.0-amd64.exe
release_gate OK 1.6.0 windows-amd64 http://127.0.0.1:38991/qinyuanj/kacha/releases/download/v1.6.0/kacha-setup-1.6.0-amd64.exe
```

两处门禁合起来核对：四件资产齐全、`SHA256SUMS` 与真实字节一致、描述版本是正式 `X.Y.Z`、描述不含非本平台清单、描述含 `# <版本>` 一级标题、平台是 `windows-amd64`、包地址指向 `v<版本>` 且签名存在；描述的平台 / 包地址与发行资产地址一致，另由 §4.3 的客户端选版测试（`validateDescriptor`）核对。

客户端行为（`desktop/internal/updateservice/acceptance_test.go`，默认跳过；验收时用环境变量启用）：

Go 测试在 `desktop/internal/updateservice` 目录里运行，资产目录**必须给绝对路径**（相对路径会找不到）：

```bash
W="D:/dev/github/kacha/.scratch/spec-150/acceptance-165/isolated-release"
KACHA_ACCEPTANCE_RELEASE_DIR="$W/releases" \
KACHA_ACCEPTANCE_PUBKEY="$(cat "$W/keys/mygo-update.pub")" \
KACHA_ACCEPTANCE_BASE_URL=http://127.0.0.1:38991 \
go test ./desktop/internal/updateservice -run TestIsolatedReleaseAcceptance -v -count=1
```

输出（节选）：

```text
=== RUN   TestIsolatedReleaseAcceptance
    acceptance_test.go: 本次构建没有内置发布者公钥：正式发布前必须在发布环境写入（这次验签用的是注入的测试公钥）
    acceptance_test.go: 选版通过：1.5.0 → 1.6.0，下载 4342005 字节且验签通过
    acceptance_test.go: 拒绝篡改包：更新包验签失败，已拒绝安装：updateservice: the package is not signed by the publisher
    acceptance_test.go: 拒绝篡改签名：更新签名不可用：描述里的签名与 .sig 附件不一致
    acceptance_test.go: 可安装状态通过：安装器 kacha-setup-1.6.0-amd64.exe，参数 /S，SHA-256 f266aa57f5aee2631a0a2e32eb0ee293310d9960eb89cbe647e36e78cf66472e
--- PASS: TestIsolatedReleaseAcceptance (0.36s)
PASS
ok  github.com/qinyuanj/kacha/desktop/internal/updateservice  0.413s
```

这条测试覆盖：未验签前 `Install` 被拒；只选高于当前的正式版本；描述、安装器与签名三者齐全；下载字节数与描述一致；验签通过才进入 `ready` / `installable`；包被改一个字节就验签失败、安装入口拒绝且不启动安装器；描述签名与 `.sig` 不一致时明确拒绝；恢复正确资产后能重新进入可安装状态；安装器启动参数是 `/S`，启动后退出应用；下载到的安装器 SHA-256 与发布资产一致。

**这条证据的边界**：

- 1.6.0 的安装器字节是 1.5.0 安装器的副本（已改名并重新签名）。它验证的是版本化元数据与信任链，不是第二个功能版本；**不能**用来判定「装 1.6.0 后版本号变成 1.6.0」或任何升级行为。真正的双版本真机升级需要发布环境另出 1.6.x 构建。
- 客户端当前构建**没有内置发布者公钥**（`desktop/internal/updateservice/publisher_key.txt` 只有注释，非注释行计数为 0），所以真实构建的 `Features.Update = false`、更新入口显示尚不可用；测试里的公钥是运行时注入的。
- 测试密钥是临时的一次性密钥；没有提交、没有进入构建产物或发行资产。

### 4.4 受控网关替身主流程（**非真实网关**）

```powershell
npm --prefix client test -- src/shell/desktopGeneration.test.ts src/shell/desktopImageEdit.test.ts
# 图层拆分与队列 / 份数覆盖见 src/core/runner.test.ts、src/core/submission.test.ts、src/ui/previewLayers.test.ts、src/core/layerCount.test.ts
go test ./desktop/internal/gateway -v -count=1
```

结果：前端 2 个文件 / 5 个用例通过；Go 网关 10 个用例通过。

覆盖：确认文本、请求与任务记录一致；一份一结果；结果与任务目录落盘；保存重开后仍见结果；401 / 5xx / 畸形响应 / 下载失败 / 429 退避 / 离线 / 取消 / 中断；参考图区域叠加与快照；透明背景与图层拆分（含部分图层失败）；跨画板队列、份数与逐份取消；API 密钥持久化与脱敏、数据根切换。以上全部由 `httptest` / `node:http` 替身驱动，**不是真实网关成功**。

### 4.5 外部条件核实

下表是本次实跑的检查；带 `$env:` 的命令按 PowerShell 写法给出，其余在 Git Bash 中执行。

| 条件 | 核实命令 | 结果 |
| --- | --- | --- |
| 网关配置 | `ls "$env:APPDATA\Kacha\data\.kacha"` | 只有 `ui-state.json`；没有 `settings.json`、`models-cache.json` |
| 网关密钥 | `ls "$env:APPDATA\Kacha\data"` | 只有 `.kacha` 与 `画板`；没有 `api-key.protected`（Gateway 的密钥文件在数据根） |
| 网关环境变量 | 过滤 `env` 里的 `KACHA_` / `GATEWAY` / `API_KEY` | 没有输出 |
| Gitea 令牌 | `$env:GITEA_TOKEN` | 空（`GITEA_URL` 有值：`http://lzxsvn:3000`） |
| Gitea 只读核查 | `curl -sS --max-time 8 "http://lzxsvn:3000/api/v1/repos/qinyuanj/kacha/releases?limit=5"` | 可达；最近的发行是 v1.4.0 / v1.3.1 / v1.3.0 / v1.2.0 / v1.0.0，资产均为 `kacha-web-*-win-x64.zip` 与 `.sha256`；没有桌面安装器、没有 v1.5.0 |
| 发布签名私钥 | `Get-Item` 查看 `$HOME\.kacha\updater\signing.key*` 的 Length | `signing.key` 348 字节（base64 解码 259 字节）、`signing.key.pub` 152 字节（解码 114 字节）；MyGo 期望 64 / 32 字节 |
| 私钥可用性 | 用该私钥跑 `go run ./tools/signrelease ...` | 明确拒绝：`签名失败：私钥长度是 259，期望 64（mygo keygen 的 mygo-update.key）` |
| 构建内置公钥 | 统计 `desktop/internal/updateservice/publisher_key.txt` 去掉注释行后的非空行 | `0` |
| 交互会话 | `quser` | `console` 会话 Active、用户已登录；但本代理没有驱动原生安装器 / SmartScreen 的交互能力，也没做静默安装（它会改动用户机器，且不能替代人工观察） |
| 本机旧安装 | `Get-Item "$env:LOCALAPPDATA\Programs\Kacha\kacha.exe"` | 存在旧版 **0.3.0**（7,575,040 字节，`NotSigned`）；未发现 Kacha 的开始菜单快捷方式或卸载注册项（已查 HKCU / HKLM Uninstall 与 Start Menu） |
| 本机生成记录 | `ls "$env:APPDATA\Kacha\data\画板"` | 空；本机没有真实生成任务记录，全规格真实网关预算已用 0 |

## 5. 结论索引

- 2026-11-21 的结清结论见 Issue #165；相关真机生成、签名发行与双版本升级结论另见 `docs/release/ACCEPTANCE-179-RUNBOOK.md` 与 `docs/release/AUTONOMOUS-E2E-20261120.md`。
- 当时的自动层证据仍以第 4 节为准：完整验证、构建产物、隔离测试发行与受控网关替身是四类不同证据，不互相冒充。
- 前端 CRAP / DRY 通过；Go 只有 `go test ./...`，不宣称 Go 三项质量指标通过。变异测试按项目约定未运行。
