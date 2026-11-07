# Agent instructions

默认使用中文与用户沟通；代码、命令、路径和既有技术术语按项目惯例保留原文。

## 开发环境

主开发平台是原生 Windows，在 PowerShell 下开发和验证；部署目标 lzxsvn 同样是 Windows。

- 用 `python`，不要用 `python3`：Windows 上 `python3` 是应用商店的占位程序。
- 不要调用 `bash`：它进入没有工具链的 WSL。仓库脚本都用 Python 或 PowerShell 写。
- 跨平台代码保留 Linux 分支，但只在 Windows 上实测。

## 构建与打包

日常验证使用 dev/debug 构建；正式部署才使用 release 构建。保留 Cargo 默认并行策略。执行部署构建前，先读 `packaging/README.md` 并使用 `packaging/build_web.py` 入口。

## Agent skills

### Issue tracker

Issues：创建、读取、更新工作票或推进 wayfinder 地图时，使用 GitHub Issues，并先读 `docs/agents/issue-tracker.md`。

### Domain docs

项目采用 single-context 域文档布局。详见 `docs/agents/domain.md`。
