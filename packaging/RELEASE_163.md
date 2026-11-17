# Windows 安装器、签名与 Gitea 发布链（#163）

本票交付的是**可重复生成、可审查、可重试**的 Windows x64 发布链；是否已在 Gitea 正式发布、是否完成双版本真机升级，须另有凭据和交互证据，不能由本地构建或脚本测试推定。

## 原生安装与更新资产

MyGo 固定在 `go.mod` 的 v0.9.0（ADR 0023）。已用该版本 CLI 核实：`go tool mygo build` 生成 Windows x64 当前用户 NSIS 安装器 `kacha-setup-<版本>-amd64.exe`，无需管理员权限，提供开始菜单入口、可选的桌面快捷方式与设置中的卸载入口；`-skip-installer` 只用于 debug 验证。

`packaging/build_desktop.py`：

- debug 构建继续使用 `-debug -skip-installer`，产物在 `build/debug/windows-amd64`。
- release 构建不加 `-skip-installer`，必须产出当前用户安装器，否则构建失败。
- `build-info.json` 记录安装器路径、唯一版本、平台、MyGo / Go / WebView2 版本。
- 更新签名由 MyGo 使用 `MYGO_UPDATER_PRIVATE_KEY` 生成。私钥只存在受限发布环境，不写入仓库、`build-info.json`、日志、测试夹具或发行资产；客户端只内置公钥。

## 两类签名必须分开

- **Windows Authenticode / SmartScreen**：操作系统代码签名，需要购买 / 使用代码签名证书。本次未购买证书，安装器未做 Authenticode 签名，Windows 可能提示 SmartScreen；按用户明确确认放行。这不是更新包发布者签名。
- **更新包发布者签名**：MyGo 用 Ed25519 私钥对更新归档签名，客户端用内置公钥验签。哈希与 `SHA256SUMS` 只能发现损坏或截断的下载，不能替代签名，也不能证明发布者身份。

复用或核验历史发布私钥前，必须在受限发布环境验证密钥可用且公钥匹配；验证失败即停止发布。未取得可用性证据时记为外部阻塞，不宣称可发布。

## 发布门禁

`packaging/release_gate.py` 的 `validate_release_assets()` 在上传前核对：

- 版本必须等于唯一来源 `mygo.config.ts`；
- 平台必须是 `windows/amd64`；
- 发布包 URL 必须指向同一版本的 `v<版本>` Gitea Release 附件；
- 发布者签名必须存在（哈希不算签名）；
- 更新描述必须含同一版本的一级标题。

`packaging/publish_release.py`：

- token 只从 `GITEA_TOKEN` 读取，不接受命令行或仓库文件；
- 每次发布前检查完整资产与 `SHA256SUMS`，不齐或哈希不一致时零远端写操作；
- 复用已有 `v<版本>` Release，不覆盖历史 tag；
- 重复发布先撤下本端旧更新描述，再替换资产，最后上传 `update-windows-amd64.json`，避免暴露半套资产；
- 上传失败可用同一命令重试，已存在的 Release 与旧资产不会被删除或新建虚假版本。

用法（受限发布机，私钥/令牌只从环境提供）：

~~~powershell
python packaging\build_desktop.py
# 确认 build/windows-amd64 下安装器、签名、update-windows-amd64.json 与 SHA256SUMS 齐全
$env:GITEA_TOKEN = "***"
python packaging\publish_release.py --base-url <Gitea 内网或 VPN 地址>
~~~

## 当前外部阻塞与验收边界

- 当前环境只有 `GITEA_URL`，没有 `GITEA_TOKEN`；没有 MyGo 更新私钥可用性与公钥匹配的正式证据。本地脚本与构建测试通过**不代表已上传、已发布或已完成双版本升级验收**。
- 首次安装、非管理员安装、开始菜单/桌面快捷方式、卸载默认保留画板与凭据、自定义数据位置、升级保留数据、SmartScreen 放行，以及下载→验签→用户点击→重启的真实链，必须在已解锁 Windows x64 交互会话中用隔离测试发行留证；本票不伪造这些证据。
- 旧 0.3.x 不在原地自动升级范围内；旧用户首次手动安装后通过画板包迁入。历史正式发行与本平台已有资产不得覆盖。

