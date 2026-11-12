---
status: accepted
---

# 截图粘贴进画板：Ctrl+V 看剪贴板里是什么，Ctrl+C 看选的是谁

> 本文件在 `research/nonsecure-image-clipboard` 中是 2026-11-12 的修订草案，尚未由 lead 采纳或合入 main。研究证据见 [非安全上下文图片剪贴板研究](../../research/nonsecure-image-clipboard/README.md)。

2026-11-11 决定（[从系统剪贴板粘贴图片](https://github.com/qinyuanj/kacha/issues/96)、[把画板上的图片复制到系统剪贴板](https://github.com/qinyuanj/kacha/issues/98)）：同一个 Ctrl+V 要同时服务两种粘贴——画板内的节点复制粘贴，以及把系统剪贴板里的截图接成参考图节点；Ctrl+C 还要能把画板上的图片交给别的软件。

前提是部署形态：页面默认跑在内网 HTTP 上，不是安全上下文，`navigator.clipboard.write/read` 与 `ClipboardItem` 不存在。因此**读**仍只能靠 paste 事件。2026-11-12 的 Issue 122 实测纠正了原来的写入推论：`img` / `canvas` 选区 + `execCommand("copy")`、原生 copy 事件 `setData()` 与 DataTransfer/拖放均未写入 Windows 位图；命令返回 true 和原生 copy 事件都不能证明图片进入系统剪贴板。

决定分三层：

- **Ctrl+V 的语义由系统剪贴板里的内容决定。** 复制节点时，除应用内的内存剪贴板外，再向系统剪贴板写一段节点标记文本（`kacha:clip:v1:<节点数>`，沿用现有的写文本降级实现：安全上下文用 Clipboard API，内网 HTTP 用 textarea + 复制命令）。粘贴时先读剪贴板里的纯文本判标记，命中就粘节点；否则剪贴板里有图片就落成参考图节点；两者都没有就放行给浏览器。两种粘贴都在 paste 事件里完成——键盘事件里拦默认行为会把 paste 事件一起压掉，所以 Ctrl+V 不再由键盘事件处理。
- **Ctrl+C 的语义由选区决定。** 选区恰好是单个图片节点（参考图节点或结果节点）时，目标是复制图片、不写节点标记；其余选区保持节点复制并写标记。默认内网 HTTP 下没有已验证的页面自动写图路径，因此在这个部署形态下暂停自动图片复制及其成功承诺，保留“另存为…”下载。
- **图片写入不再走 legacy 路径。** 2026-11-11“Windows Edge + 内网 HTTP + PNG 能粘进 Word”的 spike 撤回其证据效力：公开图片 URL 可经 HTML Format 被 Word 自行抓取，不能证明浏览器写了位图。若产品必须保留自动 Ctrl+C，另行决定用受信任 HTTPS 把页面变为安全上下文，再使用异步 Clipboard API；来源例外开关仅作受控实验，不作为默认部署。
- **浏览器原生“复制图像”是手动替代，不是 Ctrl+C 实现。** Edge 158 在非安全 HTTP + cookie 图片下实测写入 PNG、Bitmap 与 DeviceIndependentBitmap。该 privileged UI 不能由页面脚本调用，也不提供应用内成功判定；在 Kacha 原图预览、其他浏览器和目标软件实测前，只能作为候选手动路径。

## Considered Options

- **图片优先（剪贴板有图就粘图）**：否决。复制节点后立刻粘贴会静默粘出几小时前的旧截图。
- **内部剪贴板优先**：否决。刚截完图粘贴会静默粘出上次复制的旧节点。
- **换快捷键分工**（Ctrl+Shift+V 粘节点、Ctrl+Shift+C 复制图片）：否决。既有 Ctrl+C/V 的手感要保留，用户明确要求直接按 Ctrl+C 就能把图拿到别的软件。
- **默认 HTTP 下用 Clipboard API 写图片**：不可行，API 与 ClipboardItem 不存在。若保留自动写图，HTTPS 是优先评估的解锁方式；不能把 API 不存在扩写成“原生浏览器 UI 也不能复制图片”。
- **继续使用 img/canvas 选区、copy 事件 setData 或 DataTransfer**：否决。实测均不产生 Windows 位图，polyfill 没有独立底层能力可绕过这一结果。
- **让服务端参与剪贴板**（生成临时文件让用户去拿）：否决，把一步动作变成两步；短时效匿名 URL 也不能保证系统位图，并增加资源泄漏面。
- **用“最近一次操作”的时间启发式判断意图**：否决，静默做错比多一条提示更糟。

## Consequences

- 复制节点会覆盖系统剪贴板里原有内容；自动图片复制暂停后，不得让旧图片或仅 HTML/文本的新内容被界面宣称为复制图片成功。
- 标记文本可能被用户粘到别处，出现一行 `kacha:clip:v1:3` 这样的字符串。
- 标记只在当前页面有效：标记命中而内存剪贴板为空（刷新页面、另一个标签页）时必须提示重新复制，不能静默什么都不做。
- 单选一个参考图节点时，Ctrl+V 从“偏移复制（保留原名与尺寸）”变成“重新导入一张新图”（名字变成 `粘贴-…`、尺寸按比例重算）；结果节点本来就不在内部剪贴板里，所以只增不减。
- 浏览器解不了的格式仍应明确失败并提供下载；粘贴侧继续读取原生 paste 事件提供的字节，不主动抓取远程 URL。
- 图片复制验收必须在浏览器进程外读取 Windows 系统剪贴板，并校验 PNG/DIB/Bitmap 内容；`execCommand` 返回值、原生 copy 事件和 Word 抓 URL 都不是完成证据。
- 原生右键手动路径、HTTPS 自动路径及目标软件兼容分别验收，不能互相替代。
- 首次粘贴会在用户数据根下落一份“导入参考图”，与手工上传的参考图完全同源、同一条清理与用量规则（[ADR 0018](0018-web-app-replaces-desktop-client-with-server-side-task-directories.md)）。
