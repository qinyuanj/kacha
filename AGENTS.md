# Agent instructions

默认使用中文与用户沟通；代码、命令、路径和既有技术术语按项目惯例保留原文。

## 开发与验证

主开发平台是原生 Windows，使用 PowerShell。产品是单机优先的 MyGo / Go 桌面客户端，React 画板通过壳端口访问本机能力。版本只在 `mygo.config.ts` 声明。

构建、验证或排查 Windows 文件权限问题前，先读 `packaging/README.md`。日常使用 debug 构建，正式交付才使用 release 构建。需要本地验证时手动运行 `python packaging\verify.py`，合入集成分支前运行 `python packaging\verify.py --quality`（发版门禁只含 CRAP 与重复检查，不含变异测试；不要跑 `python packaging\quality.py --mutate`，本机会整机崩溃，原因与恢复条件见 `docs/adr/0020`）。当前桌面未实现的能力保持明确不可用，文档和测试不得把领域规则当成已交付功能。

## 工作票

创建、读取、更新工作票或推进 wayfinder 地图时，使用 GitHub Issues，并先读 `docs/agents/issue-tracker.md`。

## 领域文档

探索领域概念或修改画板、任务目录、画板包行为前，先读 `docs/agents/domain.md`，按其中入口读取词表和相关 ADR。
