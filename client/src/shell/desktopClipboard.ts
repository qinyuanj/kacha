// 系统剪贴板的页面侧转换（#129）：Go 侧快照 → 界面要的 ClipboardContent。
// 纯函数，不碰 DOM、不起 MyGo runtime：单测直接喂快照形状，验类别与图片顺序。
import { base64ToBytes } from "../core/base64";
import type { ClipboardContent, ClipboardKind, ClipboardReason } from "../core/clipboardDispatch";
import type { DesktopClipboardSnapshot } from "./desktop";

/** Go 侧的类别名 → 页面类别；没见过的类别按「有内容但用不了」处理，不静默丢。 */
const KIND_BY_GO: Record<string, ClipboardKind> = {
  mark: "mark",
  images: "images",
  text: "text",
  empty: "empty",
  unsupported: "unsupported",
  busy: "busy",
};

/** Go 侧的原因码 → 页面原因。 */
const REASON_BY_GO: Record<string, ClipboardReason> = {
  files: "files",
  format: "format",
  tooLarge: "tooLarge",
  busy: "busy",
  changed: "changed",
  failed: "failed",
};

/** 图片格式 → 落盘扩展名：剪贴板里的图一律按 PNG 交换（见 ADR 0023）。 */
export function extensionOf(file: File): string {
  if (file.type === "image/jpeg") return "jpg";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  return "png";
}

/** PNG 字节 → File：走既有导入链路（isImageFile 认 image/png，size 就是字节数）。 */
export function bytesToFile(bytes: Uint8Array, name: string, type = "image/png"): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}

/**
 * Go 侧快照 → 界面的 ClipboardContent：类别与原因折成页面枚举，base64 的 PNG 还原成 File。
 * 图片按剪贴板里的顺序还原（多图粘贴的顺序由此决定，不在别处再排一次）。
 */
export function clipboardContentOf(snapshot: DesktopClipboardSnapshot): ClipboardContent {
  const kind = KIND_BY_GO[snapshot.kind] ?? "unsupported";
  const reason = snapshot.reason ? (REASON_BY_GO[snapshot.reason] ?? "failed") : null;
  const images = (snapshot.images ?? []).map((text, i) => bytesToFile(base64ToBytes(text), `粘贴-${i + 1}.png`));
  return {
    kind,
    text: snapshot.text ? snapshot.text : null,
    images,
    reason,
    readFailureCount: reason === "files" ? 1 : 0,
  };
}

