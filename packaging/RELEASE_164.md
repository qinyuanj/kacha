# 可信自动更新与安全重启安装（#164）

自动更新只在**内置发布者公钥**的发布构建里开放。选版、下载与签名校验都在 Go 服务
`desktop/internal/updateservice`；页面只按快照分支，自己不做信任判定。

首日整体验收（#165）记录见 [ACCEPTANCE-165.md](../docs/release/ACCEPTANCE-165.md)：隔离测试发行的选版、验签与拒篡改已有可复核证据；正式发布、真机升级与 SmartScreen 观察在 2026-11-17 写下时仍阻塞，owner 2026-11-21 已确认结清。

## 已实现并已验证

- **选版**：只认 `X.Y.Z` 形式的正式版本，跳过草稿、预发布、不高于当前版本的发行；
  并且要求该发行同时带齐三样资产：安装器、`.sig` 签名、`update-windows-amd64.json`
  更新描述。描述里的版本、平台（`windows-amd64`）、包地址、签名与 `# <版本>` 标题
  必须与这份发行对得上，否则按「资产不完整」跳过——不提示半套资产。
- **检查时机**：启动后约 3 秒检查一次；每次检查**结束**后约 6 小时再检查；
  设置里随时可以手动检查，手动检查不受排程限制。
- **下载与验签**：下载到 `<数据根>/更新/`，边下边算 SHA-256，再用内置的发布者公钥
  做 Ed25519 验签。**下载完成不等于已验签**：只有验签通过才进入可安装状态。
  哈希只用来发现损坏，不能代替签名。
- **安装**：只有用户点「下载并安装」才会启动安装器（`/S` 静默），随后退出本应用
  让安装器替换正在运行的可执行文件。启动安装器失败时回到可安装状态并给出原因，
  旧版本照常可用。
- **安装前的保护**：有未结束的生成任务时拒绝安装并提示「任务结束后可更新」；
  否则拒绝新提交、等在途操作结束、严格保存全部打开的画板与界面状态；任一保存失败
  就解除保护、恢复正常创作。

## 发布环境边界

自动更新是否放开取决于构建时内置的发布者公钥；当前仓库已有公钥，私钥仍在发布环境，不写入仓库、构建产物或发行资产。旧 Tauri 的 rsign 密钥不能用于 MyGo Ed25519 签名。

发布链除私钥与令牌外，真机安装、非管理员安装、开始菜单入口、升级保留画板和凭据、SmartScreen 提示仍必须在已解锁 Windows x64 会话中留证；自动化验签与构建通过不能代替这些人工证据。

## 发布步骤（发布环境）

```powershell
# 发布身份已确定：先核对本次私钥与客户端内置公钥配对；非 0 就停止发布。
go run ./desktop/cmd/verifyrelease -check-private-key
$env:MYGO_UPDATER_PRIVATE_KEY = Get-Content mygo-update.key -Raw
# 构建安装器（构建前会检查版本与更新说明）
python packaging\build_desktop.py
# 签名并写更新描述（说明取 changelog.md 的当前版本一节）
go run ./tools/signrelease -installer build/windows-amd64/kacha-setup-<版本>-amd64.exe -version <版本> -notes docs/release/changelog.md -out build/windows-amd64
# 写 SHA256SUMS（只用来发现损坏，不能代替签名），再按客户端同一路径验签
go run ./desktop/cmd/verifyrelease -installer build/windows-amd64/kacha-setup-<版本>-amd64.exe -descriptor build/windows-amd64/update-windows-amd64.json
# 上传（需要 GITEA_TOKEN；默认读 build/windows-amd64，脚本会再验一遍签名与包地址）
$env:GITEA_TOKEN = "<token>"
python packaging\publish_release.py
```

发布说明只有一个来源：`docs/release/changelog.md` 的当前版本一节（ADR 0024）。
签名工具与发布脚本都从那里取说明，不另写 `release-notes-<版本>.md`：
两份说明迟早对不上，而用户只该看到一份。

`mygo.config.ts` 刻意**不配** `updates` 段：MyGo 的 `updates` 签的是
`<slug>-<版本>-windows-amd64.tar.gz` 应用归档，并写出同名的
`update-windows-amd64.json`，与本项目的 NSIS 安装器资产语义冲突。安装器的签名由
`tools/signrelease` 完成，描述字段与客户端 `updateservice.Manifest` 一致。

客户端自己拉取发行列表与描述，因此发布时 `update-windows-amd64.json`、安装器与
`.sig` 三者必须一起上传（`publish_release.py` 已经按这个顺序保证：先撤下旧描述，
再传资产，最后传描述）。

`desktop/internal/updateservice/release_tool_test.go` 会真跑 `tools/signrelease`，
再用客户端的验签规则核对——发布端与客户端不会各说各话。
