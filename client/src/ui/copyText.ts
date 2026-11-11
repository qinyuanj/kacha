/** 复制图片（#98）：失败不改变画板；既有图片下载动作就是兜底。 */
export const COPY_TEXT = {
  imageReason: {
    decode: "浏览器无法解码这张图片（可能是不支持的格式，如 HEIC）",
    unavailable: "当前浏览器不支持或拒绝把图片写入系统剪贴板",
  },
  imageFailed: (reason: string) => `复制图片失败：${reason}；请改用图片节点的下载功能`,
} as const;
