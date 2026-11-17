# Seedream Flash 模型身份与官方契约

官方文档原读取日为 2026-10-09。Flash 完整 ID 为 `doubao-seedream-5-0-flash-260915`，是独立模型，不是 Lite 别名。Lite 已从客户端上架清单移除，旧任务记录仍不可改写成 Flash 身份。

## 与其他模型不能混用的规则

Flash 普通请求最多 10 张参考图，支持 1K、1.5K、2K 或精确 `WxH`，总像素范围 921600 至 4624220、宽高比 1/16 至 16。旧 Lite 的 11 至 14 张输入、3K 和 4K 不能直接沿用。

普通生成只产一个结果，不支持配置 `sequential_image_generation`，也不发送 `n`、`seed`、原生负向或 mask。提示词优化只用 standard，不能继承 pro 的 fast。响应支持 URL 或 base64、PNG 或 JPEG，水印默认开启，URL 会失效。

区域提示坐标范围 0 至 999；图层定位的 normalized 范围 0 至 1000。透明背景要求单张带 alpha 输入与 PNG 输出。图层拆分使用专用档位或 auto，底图和图层属于一个生成结果，不按普通多图处理。

官方参数事实、团队网关实测和客户端实现分别记录。官方页面或模型发现列表不证明团队网关已采纳参考图、按尺寸生成或透传图层。实际夹具与实现边界见 [Flash 接入依据](seedream-flash.md) 和 [网关契约](../contracts/team-gateway-contract.md)。

## 一手来源

原文通过官网文档中心公开接口读取：

```text
https://www.volcengine.com/api/doc/getDocDetail?LibraryCode=ark&DocumentCode=<code>
```

下列 SHA-256 对应原始 `Result.MDContent` 的 UTF-8 字节，用于辨认原协议证据，不是当前网关实测。

| 官方页面 | DocumentCode | MDContent SHA-256 |
| --- | --- | --- |
| [模型发布公告](https://docs.volcengine.com/docs/ark/model-release-announcement) | model-release-announcement | `d40d15404114f20c9c5a0a0dcd7142b2176cee4a60d48ce95cc1832f34cf9009` |
| [模型列表](https://docs.volcengine.com/docs/ark/model-list) | model-list | `78109fba41fb29cf20d3db0c728dc0d6513fd159d00b9e2417adeee479998f9b` |
| [图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api) | image-generation-api | `e350ac947953b00d7bc42f8e29ca3242687f848b6ff2838a81011827d2ad4b0b` |
| [pro / flash 教程](https://docs.volcengine.com/docs/ark/seedream-5-0-pro) | seedream-5-0-pro | `718f8a43e5e6306e848efd6e44cdcffa266c900366ca87857b2ed7385c32d31b` |
| [交互编辑指南](https://docs.volcengine.com/docs/ark/seedream-5-0-pro-editing-guide) | seedream-5-0-pro-editing-guide | `557e3e6c55136bd70c3387f025a6ba4a92b303dd74d96e981f15208dd24a241f` |

原始脱敏网关夹具位于 `contracts/fixtures/`，保持原样。旧 Lite/pro 证据只证明采集时的行为，不移作 Flash 实测结论。
