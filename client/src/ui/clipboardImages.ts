// 剪贴板图片归一化（#113）：把原生 paste 事件里的文件列表与图片条目读成一份有序、去重的图片集合。
// 同一张图经两条途径重复暴露时只保留一份；图片条目只认 getAsFile() 给出的真实字节，不凭 MIME 声明认定成功。
// 内嵌 data URL 是第三类来源（#114 在这份产物上接解码）：形状里已经为它留好位置。
import { isImageFile } from "./canvasDrop";

/** 剪贴板条目：只取粘贴逻辑用得到的部分（真浏览器里就是 DataTransferItem）。 */
interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** 原生 paste 事件里的剪贴板内容：文件列表与条目列表可以只给一边。 */
export interface ClipboardContents {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<ClipboardItemLike> | null;
}

/**
 * 一条图片来源：文件列表给的、图片条目给的，或内嵌 data URL（解码出字节前 file 为 null）。
 * 联合里加一类来源，就是这里加一条——后续来源不要另起一套读取逻辑。
 */
export type ClipboardImage =
  | { source: "file"; file: File }
  | { source: "item"; file: File }
  | { source: "dataUrl"; dataUrl: string; file: File | null };

/** 归一化结果：图片按事件里可确定的顺序排好；opaque 是「看着像内容却读不到受支持图片」的个数。 */
export interface ClipboardImages {
  images: ClipboardImage[];
  opaque: number;
}

/**
 * 图片指纹：同一张图经文件列表与图片条目暴露时，名字、类型、大小一致，据此去重。
 * 两条途径给的是不同 File 实例，只能靠内容特征判断是不是同一张。
 */
function fingerprint(file: File): string {
  return `${file.name}\u0000${file.type}\u0000${file.size}`;
}

/**
 * 把剪贴板里的图片读成一份有序、去重的集合。
 *
 * 顺序：先文件列表（按列表原序），再图片条目（按条目原序）——事件里能确定的顺序就这么多。
 * 去重：条目里已经由文件列表给出的那张不再算一份；同一条目重复出现也只算一份。
 * 读不到内容的（零字节、取不到文件、不是图片）计入 opaque，交给既有的失败反馈提示。
 */
export function normalizeClipboardImages(contents: ClipboardContents): ClipboardImages {
  const images: ClipboardImage[] = [];
  let opaque = 0;
  const seen = new Set<string>();

  const files = contents.files;
  for (let i = 0; files && i < files.length; i++) {
    const file = files[i];
    if (file && isImageFile(file) && file.size > 0) {
      images.push({ source: "file", file });
      seen.add(fingerprint(file));
    } else {
      opaque += 1;
    }
  }

  const items = contents.items;
  for (let i = 0; items && i < items.length; i++) {
    const item = items[i];
    if (!item || item.kind !== "file") continue;
    // 只认真实字节：条目自己声明的 MIME 不作数，取不到内容就是读不到。
    const file = item.getAsFile();
    if (!file || !isImageFile(file) || file.size <= 0) {
      opaque += 1;
      continue;
    }
    const key = fingerprint(file);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ source: "item", file });
  }

  return { images, opaque };
}

/** 归一化产物里已经带真实字节的图片（data URL 那一类要等解码后才有字节）。 */
export function clipboardImageFiles(images: readonly ClipboardImage[]): File[] {
  return images.flatMap((image) => (image.file ? [image.file] : []));
}
