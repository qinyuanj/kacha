# 图片生成与编辑使用 generations 顶层字段

Qwen 文生图与图片编辑统一使用 `POST /v1/images/generations`。参考图按序编码为顶层 `image` data-URL 数组，提示词、原生负向、数量、尺寸与水印分别使用顶层 `prompt`、`negative_prompt`、`n`、`size`（`WxH`）与 `watermark`，不发送 `input` / `parameters`。出图以 `metadata.output.choices[].message.content[].image` 为真源。

Flash 普通生成和参考图编辑也使用 generations 顶层有序 `image`，但解析 `data[].url` 或 `data[].b64_json`，不发送 Qwen 的元数据字段。每个生成任务只接受一个结果，图层拆分的底图和图层共同组成一个结果（ADR 0011）。

旧 edits 嵌套请求已不适用。旧夹具仍用于响应解析回放，不能当作当前请求协议；实测日期和证据等级见[网关契约](../contracts/team-gateway-contract.md)。
