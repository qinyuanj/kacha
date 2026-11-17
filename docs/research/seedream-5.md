# Seedream 5.0 pro 能力依据

本文件保存能力表所需的官方协议事实，不代表桌面已接入生成。来源为火山引擎方舟文档，原读取日 2026-09-16；团队网关证据另见 [网关契约](../contracts/team-gateway-contract.md)。

## 官方约束

`doubao-seedream-5-0-pro-260628` 最多 10 张参考图，普通生成与编辑共用 generations 端点，参考图使用 `image`。尺寸可选档位或精确 `WxH`，总像素范围 921600 至 4624220，宽高比 1/16 至 16。水印默认开启，输出格式支持 PNG/JPEG，URL 会失效，客户端应及时下载。

没有原生 `negative_prompt`、`seed`、`n` 或 `mask` 字段。坐标交互编辑在提示词内写 `<point>` 或 `<bbox>`，坐标范围 0 至 999，不能与图层定位的 0 至 1000 混用。图上标记和坐标表达不占额外图片名额，高亮叠加图则占一个参考图名额。

图层拆分使用 `layer_decomposition`，底图和透明图层属于一个生成结果。透明背景只适用于单张带透明通道输入。模型能力不能直接证明网关透传行为。

## 来源

- [图片生成 API](https://www.volcengine.com/docs/82379/1541523)
- [Seedream 5.0 pro 教程](https://www.volcengine.com/docs/82379/2582774)
- [交互编辑指南](https://www.volcengine.com/docs/82379/2582775)
- [提示词指南](https://www.volcengine.com/docs/82379/1829186)

Flash 有独立模型 ID 与参数限制，见 [Flash 契约依据](seedream-flash-contract.md)，不能按名称继承 pro 的全部参数。
