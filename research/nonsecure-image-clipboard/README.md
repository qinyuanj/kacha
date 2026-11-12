# Issue 122：非安全上下文写入系统剪贴板图片研究

日期：2026-11-12（Asia/Shanghai）

票据：[Issue 122](https://github.com/qinyuanj/kacha/issues/122) / [父规格 Issue 98](https://github.com/qinyuanj/kacha/issues/98)
分支性质：throwaway research；不是产品实现，也不是对 Issue 或共享地图的回写。

## 结论摘要

1. **当前内网 HTTP 下，页面脚本控制的图片复制路径未找到可行解。** Edge 实测中，`img` / `canvas` + `execCommand("copy")`、原生 `copy` 事件 `clipboardData.setData()`、异步 Clipboard API、合成或真实拖放都没有把图片写为 Windows 位图格式。前两类可能返回成功并触发原生事件，仍无位图。
2. **“非安全上下文完全不能写图片”不成立。** Edge 158 在非安全 HTTP 页面中，用户通过浏览器原生右键“复制图像”可以写入真实 `PNG`、`Bitmap`、`DeviceIndependentBitmap`。这是浏览器 privileged UI 路径，页面无法用它实现自己的 Ctrl+C，也不能由脚本调用或可靠判定成功。
3. **对页面可编程的异步位图写入，安全上下文是必要条件。** W3C 规范把 `Navigator.clipboard` 和 `ClipboardItem` 都标为 `[SecureContext]`。本机 HTTP 下二者不存在；HTTPS 或 Chromium 来源例外开关使二者出现，同一写入代码随即成功。
4. **对 Issue 98 建议缩减复制侧。** 不保留当前 legacy 自动写图实现及其成功承诺；保留粘贴侧和“另存为…”下载。可把“打开原图预览后使用浏览器原生复制图像”作为另行实测的手动替代。若必须满足自动 Ctrl+C，优先另开 HTTPS + 内网 CA 的部署决策，再改用异步 Clipboard API；不要把来源例外开关作为默认部署方案。
5. **验收必须在浏览器进程外读取系统剪贴板。** 本目录的 Windows PowerShell 5.1 STA 读取器检查实际格式，并验证 PNG 签名、DIB 头和 Bitmap 解码尺寸；正控制通过，清空后的负控制以退出码 2 失败。

## 证据等级与范围

- **实测**：本机启动真实有头浏览器，页面按钮由 Playwright 点击，操作前后由独立 Windows PowerShell 进程清空/读取系统剪贴板。
- **文档证据**：W3C 规范、仓库 ADR 和 Issue 原文；不用文档推断替代浏览器实测。
- **未验证**：Chrome 未安装；按用户要求停止后续 Brave 实验；Word、微信、Photoshop 未在本轮启动；Kacha 产品页面未做端到端操作。
- 本实验是票据明确允许的独立脚本，**没有**调用 `verify.py --e2e`、`npm run test:e2e` 或 `playwright test`，没有修改产品实现。

## 实测环境与方法

| 项 | 实际值 |
| --- | --- |
| OS | Windows 11 Pro，`10.0.26220.0` |
| Edge | `158.0.4370.16`，`browser.version()` 与安装文件一致 |
| Brave | Brave Origin；安装版本字段为非数值 `157.1.99.55`，UA 为 Chromium `157.0.0.0`；无法确认正式 Brave 数值版本 |
| Chrome | 标准程序目录、用户目录和卸载注册表均未发现；未实测 |
| 页面 origin | 非回环 IPv4 的随机端口 HTTP；实际示例 `http://198.18.0.1:3621` |
| HTTP API | Edge、Brave 均为 `isSecureContext=false`、`navigator.clipboard=undefined`、`ClipboardItem=undefined` |
| 读取器 | Windows PowerShell `5.1.26100.9739`，STA，WinForms + System.Drawing |
| 图片 | 固定 1×1 PNG；`/protected.png` 必须携带 `kacha_probe=valid` cookie，实际请求日志确认 cookie 存在 |

每个用例先执行 `Clipboard.Clear()`，再执行操作，最后同时记录 `GetFormats()` 与 `GetFormats(false)`。因此空剪贴板表示本次未写入，而不是旧内容或命令返回值推断。原始 Edge 记录见 [results-edge.json](results-edge.json)，策略记录见 [results-policy.json](results-policy.json)。

## 非安全 HTTP 逐候选实测矩阵

“无位图”均指实际格式中没有 `PNG` / `Bitmap` / `DeviceIndependentBitmap`，且内容校验为 false。Chrome 整列均为**未实测**，不是否定结论。

| 候选路径 | Edge 158：操作与实际格式 | Brave Origin：本轮实测 | Chrome |
| --- | --- | --- | --- |
| 同源 cookie 图片 `<img>` + DOM 选区 + `execCommand` | 返回 true，原生 copy 发生；仅 Chromium source token/URL、history/cloud 元数据；无位图 | 同样返回 true、copy 发生、无位图 | 未实测 |
| `<canvas>` + DOM 选区 + `execCommand` | 返回 true，copy 发生；HTML Format、System.String、UnicodeText、Text、OEMText、Locale 与内部格式；无位图 | 同样无位图 | 未实测 |
| 原生 copy 事件 `setData("image/png", data:image/png;base64,...)` + `preventDefault` | `setData` 未抛错，`types=[image/png,text/plain]`；系统仅文本与 `Chromium Web Custom MIME Data Format` 等；无位图 | 初轮输入是图片 URL 而非 data URL，结果同为自定义 MIME、无位图；**data URL 输入未补测** | 未实测 |
| 原生 copy 事件 `setData("web image/png", data URL)` | 系统仅文本与 Chromium 自定义 MIME；无位图 | 初轮 URL 输入无位图；data URL 未补测 | 未实测 |
| `navigator.clipboard.write([ClipboardItem image/png])` | API 与构造器均 undefined；清空后仍为空 | 同样 undefined、为空 | 未实测 |
| polyfill / 降级 | 没有独立底层写图机制；把 Blob 转 data URL 后只能落到上述 copy 事件路径，已实测无位图；未安装第三方包 | 同左；无独立实测 | 未实测 |
| `canvas.toBlob()` + 合成 `DataTransfer` / `DragEvent` | 内存中 `Files` 有 1 项，事件 dispatch 成功；系统剪贴板为空 | PNG Blob 的 `Files` 有 1 项；剪贴板为空；初轮不是 canvas Blob | 未实测 |
| canvas 原生鼠标拖放 + `DataTransfer` | 实际 dragstart/drop 均发生，dragstart 含 1 个 PNG File；系统剪贴板为空 | 实际 dragstart/drop 发生、无位图；初轮未附 canvas File | 未实测 |
| 浏览器原生右键“复制图像” | **成功**：PNG、Format17、HTML Format、UniformResourceLocatorW、Bitmap、DeviceIndependentBitmap 等；PNG/DIB/Bitmap 内容校验通过 | UIA 未找到图片菜单项，仅见“应用/编辑”；**未形成能力结论**，不记为失败 | 未实测 |

### 关于 `setData()` 的结论边界

W3C Clipboard Events 规范 §6.4.2 把 `image/png` 列入 copy/cut 事件写入的 mandatory data types，但实测 Edge 当前版本没有把 data URL 字符串转成 Windows 位图，而是放进 Chromium 自定义 MIME 格式。这是规范文本与本机实现结果的差异；本报告以实际系统格式回答本票，不把规范要求当成兼容性证据。

`ClipboardItem` 在 HTTP 下不存在。所谓 polyfill 最终仍须调用 copy 事件、execCommand 或其他页面能力；这些底层路径已经分别实测，没有发现能提升权限、构造 Windows 位图的独立机制。本结论不是“已测试所有第三方 polyfill”。

## 安全上下文解锁路径

| 路径 | 浏览器 | 实测页面/API | 系统剪贴板结果 | 代价与限制 |
| --- | --- | --- | --- | --- |
| `--unsafely-treat-insecure-origin-as-secure=http://host:port` | Edge 158 | `isSecureContext=true`，clipboard/write/ClipboardItem 均可用 | async write resolved；PNG + Bitmap + DIB，内容校验通过 | 每台客户端、每个启动入口都要带参数；精确匹配 origin；不是只解锁剪贴板，而是把整个 HTTP origin 当作安全来源；不适合默认部署 |
| 同一开关 | Brave Origin | 同上 | 同上 | 同上；按用户要求不再补其他 Brave 实验 |
| 用户级 Edge `InsecureOriginsTreatedAsSecure` 注册表策略 | Edge 158 | `edge://policy` 显示策略已加载但状态“错误”；页面仍 `isSecureContext=false`、API undefined | 无位图 | **本机未生效**；不能宣称企业策略可行。未尝试需管理员权限的 HKLM，也未实测 Chrome 策略 |
| 自签 HTTPS，正常证书校验 | Edge、Brave | 导航 `ERR_CERT_AUTHORITY_INVALID` | 未进入页面 | 自签证书本身不是零配置方案；不能靠页面代码绕过证书信任 |
| 同一自签 HTTPS，仅实验设置 `ignoreHTTPSErrors=true` | Edge、Brave | `isSecureContext=true`，异步 API 可用 | async write resolved；PNG + Bitmap + DIB，内容校验通过 | 证明 HTTPS 路径的剪贴板能力；**忽略证书不是部署建议** |
| 上述任一路径 | Chrome | 未实测 | 未实测 | 不用 Playwright Chromium 冒充 Chrome |

安全路径实际读到的共同内容：PNG 87 bytes，SHA-256 `01be51919bebc1925950d68c80527e8e2450f6bc8deeab326be1a5fc8ab73ad4`，PNG 签名有效；DIB 44 bytes、40-byte header、1×1、32bpp；WinForms Bitmap 可解码为 1×1。Edge 原生右键路径得到同一 PNG/DIB 内容，并额外带 HTML/URL 格式。

### 安全上下文结论

- 对 `navigator.clipboard.write`：**必要**。这是规范要求，也是本机 HTTP 与解锁后对照实验的共同结果。
- 对“任何方式把图片放进系统剪贴板”：**不必要**。Edge 原生右键菜单是实测反例。
- 对 Issue 98 的“页面响应 Ctrl+C，把参考图/结果底图交给其他软件”：当前默认内网 HTTP 下，本轮未找到可编程路径；若选择异步 Clipboard API，就必须把页面变成安全上下文。原生右键不能自动映射到 Ctrl+C。

## HTTPS 与浏览器策略取舍

### HTTPS + 内网 CA（若保留自动复制，优先评估）

需要的不只是服务端多监听 443：还要有固定 DNS 名称、包含该名称 SAN 的证书、内网 CA 或等效信任链、把根证书分发到每台 Windows 客户端、续期与轮换流程，以及把现有 `http://lzxsvn:3001` 配置改为 HTTPS。还要复核 Secure cookie、混合内容、反向代理和 HTTP 跳转。它改变 [ADR 0003](../../docs/adr/0003-allow-http-only-on-a-trusted-network.md) 的明文可信网络部署前提，但带来真实传输保护，而不是仅绕过 API 门禁。

本轮只实测“忽略自签错误后 HTTPS 可写位图”；**没有**安装内网 CA、做正常信任链导航或修改 Kacha 部署。

### 来源例外开关 / 企业策略

开关实测可用，但它把指定 HTTP origin 整体提升为安全上下文，会开放其他安全上下文能力；客户端启动参数管理、升级和故障排查都成为长期成本。Edge 用户级策略在本机显示错误，不能用“与命令行等价”推断它一定可部署。若 lead 仍考虑此方向，应在目标浏览器正式版本和域管环境中单独验收，并确认策略状态为“确定”而非仅存在注册表值。

## 无自动写图解时的替代方案

| 方案 | 用户结果 | 优点 | 代价/风险 | 建议 |
| --- | --- | --- | --- | --- |
| 保留“另存为…”下载，移除自动复制承诺 | 用户保存后在目标软件打开/插入 | 已有入口；保留鉴权；不伪造成功 | 多一步，不是剪贴板 | **近期默认兜底** |
| 浏览器原生右键“复制图像” | Edge 实测可得到真实位图 | 非安全 HTTP 可用；无需新鉴权面 | 必须让实际原图 img 可见；缩略图不等于底图；无法由 Ctrl+C 调用；浏览器/目标矩阵未完整实测 | 可作为**手动、缩减版**替代，先在 Kacha 预览原图实测 |
| 复制图片地址文本 | 得到 URL，不是图片 | 实现简单 | 目标软件可能只粘文字；cookie URL 无会话；容易再次把 URL 当成功 | 不作为图片复制替代；若要提供必须单独明确命名 |
| 短时效匿名图片 URL + HTML | 某些目标可能自行抓 URL | 可绕开浏览器位图写入 | 系统仍无位图；依赖目标网络/抓取行为；capability URL 会经剪贴板、日志、历史或转发泄漏；TTL、撤销、缓存、并发访问都增加鉴权面 | 不推荐默认采用；不能宣称兼容 Word/微信/PS |
| 写客户端临时文件 | 用户再取文件 | 位图字节可控 | 普通网页不能静默写任意临时目录；实际上仍是下载或新增原生 helper；服务端写自己磁盘不等于写用户机器 | 不新增临时文件机制，复用下载 |
| HTTPS 后异步 Clipboard API | 可恢复自动 Ctrl+C | 实测写入真实位图；直接满足规格方向 | 部署与代码变更；证书信任、续期、客户端配置 | 若自动复制是硬需求，优先此方向 |
| 来源例外开关后异步 Clipboard API | 同上 | 实测快速验证可行 | 每台客户端配置；扩大整个 origin 的安全能力；Edge 策略本轮失败 | 仅受控实验/临时部署，不作默认 |

## 对 Issue 98 复制侧的处置建议

建议**缩减，而非保留当前实现**：

1. 保留 #113/#114 粘贴侧；本研究没有否定原生 paste 事件链路。
2. 当前 legacy 图片 Ctrl+C 不得再以“命令 true + copy 事件”报成功。移除或暂停用户故事 28–33、38–44 中“自动写入系统位图”的完成承诺，保留下载与明确失败原因。
3. 可在规格中增加一个明确的手动替代：“打开原图预览，使用浏览器原生复制图像”；但它尚需 Kacha 页面、Brave/Chrome 与目标软件实测，不能视为已完成。
4. 若 lead 判断自动 Ctrl+C 不可削减，应新开部署决策，选择 HTTPS/内网 CA 后再做异步写入实现；不要继续修补 DOM 选区、canvas 或 `setData`。
5. 不建议用短期匿名 URL 维持表面兼容，因为它没有解决系统位图问题，还引入新的未鉴权资源访问面。

## 可重复自动化验收

### 工具

- [probe.mjs](probe.mjs)：独立 HTTP/HTTPS 服务、cookie 图片、真实浏览器操作、逐用例清剪贴板并保存 JSON。
- [clipboard-inspect.ps1](clipboard-inspect.ps1)：STA WinForms 读取；输出实际/原生格式、PNG 签名与 hash、DIB header/尺寸/bit depth、Bitmap 解码尺寸。
- [invoke-copy-image-menu.ps1](invoke-copy-image-menu.ps1)：通过 Windows UI Automation 调用原生“复制图像”菜单，作为正控制。

### 判定标准

一次通过必须同时满足：

1. 用例开始前已清空系统剪贴板；
2. 页面记录 `isSecureContext`、API 存在性和实际操作异常；
3. 外部进程读到 `PNG`、`Bitmap`、`DeviceIndependentBitmap` 至少一种；
4. 不只是格式名：PNG 必须通过 8-byte 签名，DIB 必须有有效 header 和非零尺寸，或 Bitmap 必须可解码且尺寸非零；
5. 对固定探针可额外传 `-ExpectedPngSha256`；对产品通用验收建议解码后比较像素/尺寸，而非要求原始编码字节不变。

命令示例（在交互式 Windows 桌面运行，会清空系统剪贴板）：

```powershell
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass `
  -File research/nonsecure-image-clipboard/clipboard-inspect.ps1 `
  -RequireImage `
  -ExpectedPngSha256 01be51919bebc1925950d68c80527e8e2450f6bc8deeab326be1a5fc8ab73ad4
```

退出码 0 才通过；无有效图片或 hash 不匹配为 2。实测正控制返回 0，随后 `-Clear` 再读取返回 2。应用内的 `execCommand` 返回值、原生 copy 事件、合成 ClipboardEvent 和目标软件“可能去抓 URL”的结果都不能替代这一外部断言。

### 未来验收矩阵建议

- 固定一个需要会话 cookie 的 PNG，防止公开 URL 假阳性；每次更换探针内容或 hash，排除旧剪贴板。
- 正控制：当前安全路径 async write 或 Edge 原生复制图像；负控制：legacy 路径必须不能通过位图断言。
- 浏览器外验收负责“系统有位图”；Word/微信/PS 另做目标兼容验收。透明通道需检查解码后的 alpha，不能只凭 DIB 为 32bpp。
- 该工具依赖交互式桌面和真实系统剪贴板，不应塞进普通 headless/Linux CI，也不应把它的结果降级为页面事件断言。

## ADR 0021 必须纠正的内容

本研究分支已附 [ADR 0021 修订草案](../../docs/adr/0021-clipboard-paste-dispatch-by-clipboard-content.md)，供 lead 统一处置，未合入 main：

- 删除“写只能靠选中内容后触发复制命令”的推论；它只对文本降级成立，不对系统位图成立。
- 撤回“2026-11-11 spike 已验证 PNG 能粘进 Word”的证据效力。公开 URL + HTML Format 下 Word 自行取图，不能证明浏览器写了位图。
- 撤销“写入图片走 legacy 路径”的决策；补入 copy 事件、自定义 MIME、DataTransfer/拖放的无位图实测。
- 记录 Edge 原生右键是 privileged UI 例外，不等于页面 Ctrl+C 能力。
- 把 Clipboard API 从“永久否决”改为“默认 HTTP 不可用；若保留自动写图，需要安全上下文”，并记录 HTTPS 与来源例外的代价。
- 成功判定必须加入浏览器外系统格式与内容校验；copy 命令和事件只能证明页面操作链。
- 删除或改写依赖 legacy 写图的 Consequences，避免继续承诺浏览器会解码并写图。

## 未完成验证与已知限制

- Chrome 全矩阵未实测（未安装）；没有下载安装或以 Chromium 替代。
- Brave 按用户要求停止后续实验；原生右键未调通，data URL 版 copy 事件与 canvas File 拖放未补测，精确数值版本未获得。
- Edge 企业策略仅实测 HKCU 当前用户路径，策略页为“错误”；HKLM/域组策略未实测。
- HTTPS 正常信任链未实测；仅记录未信任证书失败和测试专用 ignore-certificate 成功。
- 未在 Kacha 实际页面操作，未验证预览原图右键、缩略图/底图差异、透明像素、宽高比或目标应用粘贴。
- 未测试所有第三方 polyfill；结论基于已覆盖的可用底层机制和 API 缺失事实。
- 未修改或关闭 Issue 122/98，未操作共享地图，未运行仓库 e2e。

## 一手资料

- [W3C Clipboard API and events](https://w3c.github.io/clipboard-apis/)：§6.4.2 copy/cut 写入类型；§7.1 `Navigator.clipboard` 与 §7.2 `ClipboardItem` 的 `[SecureContext]`；§7.3.3 `write(data)`。
- [W3C Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/)：potentially trustworthy origin 与安全上下文判定。
- [Issue 122](https://github.com/qinyuanj/kacha/issues/122)：既有四种 legacy 来源无位图、Word 抓 URL 的既有事实与候选清单。
- [Issue 98](https://github.com/qinyuanj/kacha/issues/98)：复制/粘贴用户故事、部署前提和原验收要求。
- [ADR 0003](../../docs/adr/0003-allow-http-only-on-a-trusted-network.md)：可信网络明文 HTTP 前提。
- 本目录原始 JSON 与脚本：本轮实际浏览器/系统行为的主证据。

## 重跑实验

在仓库根目录、交互式 Windows 桌面执行；依赖客户端 `npm ci` 和 OpenSSL。**会清空并覆盖系统剪贴板。**

```powershell
Set-Location client
npm ci
Set-Location ..
openssl req -x509 -newkey rsa:2048 -nodes `
  -keyout research/nonsecure-image-clipboard/key.pem `
  -out research/nonsecure-image-clipboard/cert.pem `
  -subj /CN=issue122.local -days 1 -addext subjectAltName=DNS:localhost
$env:BROWSERS = "edge"
$env:MODES = "http,flag,https-untrusted,https"
$env:OUTPUT = "results-edge.json"
node research/nonsecure-image-clipboard/probe.mjs
```

`BROWSERS` 可接受 `edge,brave,chrome`，但脚本使用本机安装路径且不会安装浏览器。原生菜单自动化支持英文 Copy image 和中文复制图片/复制图像；找不到菜单项时记录未调通，不把它当成浏览器无能力。
