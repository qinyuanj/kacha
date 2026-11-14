// 复制（#130）：Ctrl+C 的语义只看选区——单选一张图复制图片，其余选区复制节点标记。
// 失败不改变画板：该节点已有的「另存为…」就是兜底，所以失败提示一律指向它（ADR 0021 / 0023）。
import type { ImageCopyFailure } from "../shell/port";

/** 复制图片失败的原因（Web 路线两种，桌面壳另有格式、占用与内容坏掉三种）。 */
export const COPY_TEXT = {
  imageReason: {
    decode: "浏览器无法解码这张图片（可能是不支持的格式，如 HEIC）",
    unavailable: "当前浏览器不支持或拒绝把图片写入系统剪贴板",
    unsupported: "这张图的格式不受支持（如 HEIC、TIFF）",
    invalid: "这张图的内容无法识别",
    busy: "剪贴板正被其他程序占用，请稍后重试",
    failed: "写入系统剪贴板失败",
  },
  /** 「另存为…」是参考图与结果节点已有的动作：复制失败时的替代路径。 */
  saveAsHint: "可改用该节点的「另存为…」",
  imageFailed: (reason: string) => `复制图片失败：${reason}；${COPY_TEXT.saveAsHint}`,
} as const;

/** 复制图片失败时的提示：原因按类别取文案，类别认不出就照原文说。 */
export function imageCopyFailureText(reason: ImageCopyFailure | string): string {
  const known = COPY_TEXT.imageReason as Record<string, string | undefined>;
  return COPY_TEXT.imageFailed(known[reason] ?? String(reason));
}
