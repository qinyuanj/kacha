# Agent instructions

默认使用中文与用户沟通；代码、命令、路径和既有技术术语按项目惯例保留原文。

## 开发环境

主开发平台是原生 Windows，在 PowerShell 下开发和验证；部署目标 lzxsvn 同样是 Windows。

- 用 `python`，不要用 `python3`：Windows 上 `python3` 是应用商店的占位程序。
- 不要调用 `bash`：它进入没有工具链的 WSL。仓库脚本都用 Python 或 PowerShell 写。
- 跨平台代码保留 Linux 分支，但只在 Windows 上实测。

## 构建与打包

日常验证使用 dev/debug 构建；正式部署才使用 release 构建。保留 Cargo 默认并行策略。执行部署构建前，先读 `packaging/README.md` 并使用 `packaging/build_web.py` 入口。

新 clone 后执行 `git config core.hooksPath .githooks` 启用 pre-push 验证；新 clone 或新建 worktree 后先跑 `python packaging\verify.py --preflight`；构建或测试报 os error 5、cl D8050、建不了符号链接时，读 `packaging/README.md`「验证」。

e2e 只在集成分支（`main`、`integration/*`）上跑，`verify.py` 会自动跳过其他分支。集成分支上全套 e2e 只由合完各票后的 push 跑一次，修复时只重跑失败的 spec。在其他分支上跑任何 e2e（`verify.py --e2e`、`npm run test:e2e`、`playwright test`，含只跑单个 spec）都要用户明确授权，一次授权只管当次。

## Agent skills

### Issue tracker

Issues：创建、读取、更新工作票或推进 wayfinder 地图时，使用 GitHub Issues，并先读 `docs/agents/issue-tracker.md`。

### Domain docs

项目采用 single-context 域文档布局。详见 `docs/agents/domain.md`。
