# 2026-11-20 晚自主 e2e 验收（1.6.6）

owner 完成 #179 真机验收后退出后续人工验收，授权 lead 自行推进并做可自动化的 e2e。本文只记实际证据与不能代签的缺口。

## 1. 生成预算记账

- 仓库最近账本：`docs/release/ACCEPTANCE-179-RUNBOOK.md` 起点为总额 25、已用 4、剩余 21；owner 真机期间消耗没有逐笔记录。
- 本轮自主 e2e **新增真实生成 1 次**（5.5 文生图，1024×1024，合成提示词），无重试。
- 不写「剩余 20」：owner 实际消耗未知，只记本轮新增 1 次。

## 2. 真实网关与真实生成

```text
GET /v1/models  HTTP 200  MODEL_COUNT=7
含 5-0-flash 与 5-5 = True
POST /v1/images/generations  model=doubao-seedream-5-5-261028
size=1024x1024  HTTP 200  data 长度 1  首项只有 url
结果图匿名 GET：HTTP 200  732196 B
magic=89504e470d0a1a0a  PNG 1024×1024
```

## 3. 请求体、图层拆分与落盘（不消耗预算）

```text
capabilities/gateway/splitInput/layerCount/desktopLayers：140 passed
gateway + run：104 passed
5.5 拆分 1 张参考图发 layer_decomposition:true 与 max_images:30；2 张被拦下
普通图片编辑不被拆分规则误拦；桌面端口落盘链路通过
```

## 4. 发行链

```text
v1.6.6 描述文件 HTTP 200，安装包 HTTP 200，4544638 B
sha256=864ecf9ea7047bdf39b0f1f83019ae9a4e446def77b967aa8bdb7a11582210e8
go run ./desktop/cmd/verifyrelease  exit 0  验签通过
```

## 5. 更新安装器与诊断脱敏

```text
TestInstallRunsTheRealInstallerSilentlyAndQuits  PASS
packaging.tests.test_installer_include  3 tests OK
链路：service.go 传 /S --relaunch → installer.nsh 读同名 flag → Exec 已安装 exe
diagnostics 5 个凭据/脱敏集成测试全部 PASS；secret 放进 detail 后 zip 与日志均无明文
```

安装器部分是 Go 注入替身 + Python 静态同构验证；本轮未跑真实 NSIS 安装包。此前 relaunch 改动落地时用 NSIS 3.13 编译真实 installer.nsh，带 flag 启动、不带 flag 不启动，并有「无钩子」对照组。

## 6. 未覆盖（不代签）

- 真实 GUI 交互与视觉语义判断。
- 真实 GUI 里「装完自启」的端到端效果（已有同构安装器证据，不等于 GUI e2e）。
- owner 预算精确余额。
- 多轮一致性、OCR 样式、拆层接近上限不塌：#179 已由 owner 当场判定通过，本轮不重复计预算。

## 7. 结论

能自动化的核心交付链均通过，未发现新缺陷。不能自动覆盖的部分按上文列明，不以自动化成功代替人工验收结果。
