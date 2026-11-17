# 可信自动更新与安全重启安装（#164）

自动更新只在**内置发布者公钥**的发布构建里开放。选版、下载与签名校验都在 Go 服务
`desktop/internal/updateservice`；页面只按快照分支，自己不做信任判定。

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

## 尚未验证（需要发布环境或真机）

以下环节**没有在本机验证过**，不得当成已交付：

1. **真实签名发布**：需要发布者私钥（`go tool mygo keygen` 生成的 `mygo-update.key`，
   放在发布环境，通过 `MYGO_UPDATER_PRIVATE_KEY` 或 `updates.privateKey` 提供）。
   本机没有这把私钥，因此没有产出真实签名资产。
2. **上传到 Gitea Release**：需要 `GITEA_TOKEN`（本机未设置）。
3. **真机安装链路**：退出 → 安装器替换文件 → 重新启动、非管理员安装、开始菜单入口、
   升级后画板与设置保留、SmartScreen 提示，都需要一台未锁定的交互式 Windows x64 会话
   与一份真实的测试发行。

在这些条件具备之前，`desktop/internal/updateservice/publisher_key.txt` 保持只有注释，
构建出的客户端会把更新入口显示为「尚不可用」，端口以 `kind: "unavailable"` 拒绝调用。

## 发布步骤（发布环境）

```powershell
# 1. 生成密钥对（只需一次；私钥留在发布环境，公钥进仓库）
go tool mygo keygen
# 2. 把 mygo-update.pub 的内容写进 desktop/internal/updateservice/publisher_key.txt
#    （覆盖注释行即可；只写 base64 那一行），然后重新构建客户端
# 3. 构建安装器
python packaging\build_desktop.py
# 4. 给安装器签名并写更新描述（私钥只从环境变量读）
$env:MYGO_UPDATER_PRIVATE_KEY = Get-Content mygo-update.key -Raw
go run ./tools/signrelease -installer build/windows-amd64/kacha-setup-<版本>-amd64.exe -version <版本> -notes docs/release/release-notes-<版本>.md -out build/windows-amd64
# 5. 写 SHA256SUMS（只用来发现损坏，不能代替签名）
# 6. 上传（需要 GITEA_TOKEN）
$env:GITEA_TOKEN = "<token>"
python packaging\publish_release.py
```

`mygo.config.ts` 刻意**不配** `updates` 段：MyGo 的 `updates` 签的是
`<slug>-<版本>-windows-amd64.tar.gz` 应用归档，并写出同名的
`update-windows-amd64.json`，与本项目的 NSIS 安装器资产语义冲突。安装器的签名由
`tools/signrelease` 完成，描述字段与客户端 `updateservice.Manifest` 一致。

客户端自己拉取发行列表与描述，因此发布时 `update-windows-amd64.json`、安装器与
`.sig` 三者必须一起上传（`publish_release.py` 已经按这个顺序保证：先撤下旧描述，
再传资产，最后传描述）。

`desktop/internal/updateservice/release_tool_test.go` 会真跑 `tools/signrelease`，
再用客户端的验签规则核对——发布端与客户端不会各说各话。
