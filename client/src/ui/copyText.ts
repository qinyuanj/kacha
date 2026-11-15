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

/** 容器名的大写写法：界面说「TIFF 不受支持」，与用户看到文件类型时的写法一致。 */
function containerLabel(detail: string): string {
  return detail.toUpperCase();
}

/**
 * 复制图片失败时的提示：原因按类别取文案，类别认不出就照原文说。
 *
 * detail 是具体对象（如认出来的容器名 tiff）：有它时提示说清「TIFF 不受支持」，
 * 没有时退回该原因的通用文案。
 */
export function imageCopyFailureText(reason: ImageCopyFailure | string, detail?: string): string {
  const known = COPY_TEXT.imageReason as Record<string, string | undefined>;
  if (detail) {
    if (reason === "unsupported") return COPY_TEXT.imageFailed(`这张图的格式（${containerLabel(detail)}）不受支持`);
    return COPY_TEXT.imageFailed(`${known[reason] ?? String(reason)}（${detail}）`);
  }
  return COPY_TEXT.imageFailed(known[reason] ?? String(reason));
}
