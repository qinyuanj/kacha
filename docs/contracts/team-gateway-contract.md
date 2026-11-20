# 团队网关契约

本文件记录模型请求协议与脱敏夹具证据。客户端只通过团队 new-api 网关调用模型，单份文生图已通过桌面端口与本机服务接入；合成回放和受控网关替身不代表真实网关验收，真实调用额度由整体验收统一管理。HTTP 网关仅用于可信内网或 VPN。

## 请求与结局

- 模型发现：`GET /v1/models`，Bearer 鉴权，按完整模型 ID 与本地能力表求交集，未知模型不启用。
- Qwen 文生图与编辑：`POST /v1/images/generations`，顶层 `model`、`prompt`、`negative_prompt`、`n:1`、`size`（`WxH`）、`watermark`，参考图为有序 `image` data-URL 数组。当前请求不使用 `input` / `parameters`。结果取 `metadata.output.choices[].message.content[].image`，兼容 URL 与 base64。
- Seedream 文生图与编辑：同一 generations 端点，顶层有序 `image`，结果取 `data`；Flash 的具体约束见下文。
- 发送文本由发送计划统一生成，序号与区域引用在提交前校验。Qwen 负向走原生字段，Seedream 负向拼入文本。
- 401 为鉴权失败，429 为限流，其他 4xx 为拒绝，5xx 为网关错误，连接或下载失败明确失败。生成不依赖未经证实的幂等键、网关取消、任务查询或 `Retry-After`。
- Flash 拒绝含 429 不自动重发或换模型；取消只表示客户端不再等待和落结果。

## Flash 普通通路

完整 ID 为 `doubao-seedream-5-0-flash-260915`。普通文生图与编辑使用精确 `WxH`，默认 url/png/无水印，提示词优化只用 standard。最多 10 张实际参考图，叠加图也占名额。单图保守上限为 30000000 字节，像素、边长、比例和格式均按能力表校验实际发送快照，处理失败不可退回不合规原字节。

不发送 `n`、原生 `negative_prompt`、`seed`、`mask`、`input.messages`、组图、流式或搜索参数。普通响应必须恰好一项有效 URL 或 base64 图片，多项、空项、坏项及下载失败均失败。临时 URL 立即下载，不写进长期任务记录。

区域可使用高亮叠加或提示文本中的 `<point>` / `<bbox>`，提示坐标范围 0 至 999。透明背景只用于恰好一张确认带 alpha 的实际参考图，输出必须 PNG；叠加把输入展开成两张时不满足该条件。

图层拆分使用 `layer_decomposition:true`，单张 PNG/JPEG 输入，尺寸仅 `1K` / `1.5K` / `2K` / `auto`，不发普通精确像素。输出按 `z_index` 识别底图与排序，位置来自 `bounding_box.absolute`，`normalized` 范围 0 至 1000。名称和描述可选，关键定位或任一图层无效则整体失败。没有真实 Flash 图层夹具，不把合成回放当网关实测。

## 富文本 OCR（5.5 拆分专属）

官方文档口径，尚无网关夹具与真机证据：#178 客户端实现与合成回放验证齐备，网关是否正确透传待整体验收。

拆分时在 `layer_decomposition_options` 里发 `{"text_recognition":true}`，关掉开关时请求体里不出现这个键。返回里文字图层的 `text_recognition` 带整段 `text`、逐行 `bounding_box` 与 `runs[].style`（`similar_font_family`、`foreground_color`、`bold`、`italic`、`underline`、`strikethrough`、`shadow`、`translucent`）。非文字层、艺术字、手写体不返回；形状不完整或空结果按「没拿到」处理，不影响已经出好的图。识别结果随图层元数据写入 `layers.json`，只在预览侧栏展示。

## 证据与限制

- `contracts/fixtures/2026-08-17-team-gateway/`：模型发现、Qwen 文生图和错误响应。
- `contracts/fixtures/2026-08-29-team-gateway-edit-json/` 与 `2026-08-31-team-gateway-edit-boundaries/`：旧嵌套编辑协议，仅保留响应回放与边界证据，不作为当前请求模板。元数据与顶层 data 数量曾不一致，因此不能用顶层 data 统计 Qwen 出图数量。
- `contracts/fixtures/2026-09-16-team-gateway-multiturn-refs-mask/`：Qwen 不支持多轮消息，结果回灌可用；图 N 与 Image N 指代、高亮叠加有实际证据，原生 mask 猜测字段被忽略。
- `contracts/fixtures/2026-09-17-team-gateway-seedream/`：当时 pro/Lite 参考图和区域行为。不能直接用来证明 Flash 能力，Lite 不再上架。
- [Flash 夹具](../../contracts/fixtures/2026-10-09-team-gateway-flash/manifest.json)：1024x1024 文生图、双图高亮叠加、1536x1536 透明三组真实脱敏交互。视觉结论来自原采集者，替代图片字节和合成测试只证明客户端处理。

默认只有真实夹具确认的能力才准入。Flash 例外允许官方明确支持、客户端实现与自动化验证齐备的能力开放，官方支持、网关实测和实现证据仍分别记录，见 [ADR 0001](../adr/0001-integrate-only-through-team-gateway.md) 与 [Flash 依据](../research/seedream-flash.md)。未知协议保持未知，不将发现列表当生成成功。

夹具不得包含密钥、完整提示词、输入图片或有效签名 URL。记录新交互前需明确授权载荷与费用，整理后人工核对脱敏；现有夹具不因文档精简而改写。
