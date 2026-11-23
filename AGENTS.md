# Agent instructions

默认使用中文与用户沟通；代码、命令、路径和既有技术术语按项目惯例保留原文。

## 开发与验证

主开发平台是原生 Windows，使用 PowerShell。产品是单机优先的 MyGo / Go 桌面客户端，React 画板通过壳端口访问本机能力。版本只在 `mygo.config.ts` 声明。

构建、验证或排查 Windows 文件权限问题前，先读 `packaging/README.md`。日常使用 debug 构建，正式交付才使用 release 构建。需要本地验证时手动运行 `python packaging\verify.py`，合入集成分支前运行 `python packaging\verify.py --quality`（发版门禁只含 CRAP 与重复检查，不含变异测试；不要跑 `python packaging\quality.py --mutate`，本机会整机崩溃，原因与恢复条件见 `docs/adr/0020`）。当前桌面未实现的能力保持明确不可用，文档和测试不得把领域规则当成已交付功能。

## 测试归属与清理

测试是契约的证据，不是实现形状的复制。新增、改动或清理测试时：

- 每个契约只有一个主 owner，放在最强证据边界；重复契约合并进 owner，不再留第二份。
- 断言必须能在它守的守卫上失败。恒真、锁定错误行为、常量自比较、复制清单、mock 自造被断言值、只断言调用形状，都不算证据。
- **先修缺陷再删测试**：测试红了先查是缺陷还是断言写错；基线失败可能是待修的 bug，不是要删的测试。不许为了让测试变绿去删或弱化断言。
- 发布、签名、版本、安装器这四类契约始终保留，清理时不得删。
- 只删仓库内已无读取方的死脚手架 / 夹具 / 运行锁残留；删前先 grep 确认真无读取方，别凭猜测。

## 工作票

创建、读取、更新工作票或推进 wayfinder 地图时，使用 GitHub Issues，并先读 `docs/agents/issue-tracker.md`。

## 领域文档

探索领域概念或修改画板、任务目录、画板包行为前，先读 `docs/agents/domain.md`，按其中入口读取词表和相关 ADR。
