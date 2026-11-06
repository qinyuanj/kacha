# 图片编辑链路改用 JSON 透传

> 状态：2026-11-06 被「Qwen 文生图与图片编辑统一使用 generations 顶层字段」取代。当前 new-api 阿里任务插件不再接受本 ADR 的 `/v1/images/edits` 嵌套透传，会在生成前返回 `image is required`。

## 当前决策

Qwen 文生图与图片编辑统一使用 `POST /v1/images/generations`。参考图按序编码为顶层 `image` data-URL 数组，提示词、原生负向、数量、尺寸与水印分别使用顶层 `prompt`、`negative_prompt`、`n`、`size`（`WxH`）与 `watermark`，不再发送 `input` / `parameters`。出图仍以 `metadata.output.choices[].message.content[].image` 为真源。

Flash 普通生成与参考图编辑同样走 generations 顶层有序 `image`，但解析顶层 `data[].url` 或 `data[].b64_json`，不发送 Qwen 的元数据字段；证据与准入见 [Flash 研究](../research/seedream-flash.md)和 ADR 0001。

## 历史依据

图片编辑原以 multipart 表单提交参考图，但网关的 multipart 转换路径只透传 n 与 watermark，尺寸与多参考图均不可用。2026-08-29 在 new-api v1.0.0-rc.27 官方零补丁网关上实测：改走 JSON（`Content-Type: application/json`，参考图编码为 data-URL 进入 `input.messages`）后，`parameters.size`（「宽*高」星号格式）、`parameters.n` 与多参考图（1～3 张）全部原生生效，无需网关补丁。因此当时编辑链路固定为 JSON 透传：请求顶层必须携带 `prompt`（网关必填），尺寸与出图数量走 `parameters`，出图以 `metadata.output.choices` 为真源而非顶层 `data`。证据见 `contracts/fixtures/2026-08-29-team-gateway-edit-json/`。这些夹具只用于响应回放，不再作为当前请求契约。
