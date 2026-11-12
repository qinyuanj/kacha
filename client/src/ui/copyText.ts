// 复制图片（#115）：失败不改变画板；每类失败都指向同一节点已有的「另存为…」下载，不自动下载。
import type { ImageCopyFailure } from "../shell/imageClipboard";

export const COPY_TEXT = {
  imageReason: {
    decode: "浏览器无法解码这张图片（可能是不支持的格式，如 HEIC）",
    rejected: "浏览器拒绝了复制命令",
    noEvent: "复制命令返回成功，但没有观察到本次原生复制事件",
    exception: "复制图片时出现意外错误",
  },
  imageFailed: (reason: string) => `复制图片失败：${reason}；请改用该图片节点的「另存为…」下载`,
  /** 失败原因到文案的映射：只在文案模块里写一份，界面不各自拼一句。 */
  imageFailureReason: (failure: ImageCopyFailure): string =>
    failure.kind === "exception" ? `${COPY_TEXT.imageReason.exception}：${failure.detail}` : COPY_TEXT.imageReason[failure.kind],
} as const;
