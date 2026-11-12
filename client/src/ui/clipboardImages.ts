// 剪贴板图片归一化（#113）与内嵌图片 data URL 解码（#114）：把原生 paste 事件里的文件列表、图片条目与
// 内嵌图片 data URL 汇成一份有序的图片集合，并给「看着像内容却拿不到受支持图片」一个可操作的原因。
// 同一张图经多条途径重复暴露时只取一次（按内容判定，不按名字与大小）；图片条目只认 getAsFile() 给出的真实字节，
// 不凭 MIME 声明认定成功。远程地址只用来给原因：应用绝不主动去抓，也不出现在任何用户可见文案里。
import { MAX_PASTE_BYTES, type PasteContent, type PasteFailures } from "../core/pageInput";
import { IMAGE_EXTENSIONS } from "../core/relocate";
import { sha256Hex } from "../core/sha256";
import { isImageFile } from "./canvasDrop";

/** 剪贴板条目：只取粘贴逻辑用得到的部分（真浏览器里就是 DataTransferItem）。 */
interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** 原生 paste 事件里的剪贴板内容：文件列表与条目列表可以只给一边；文本类内容按需给。 */
export interface ClipboardContents {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<ClipboardItemLike> | null;
  /** 纯文本（text/plain）：内嵌的 data URL 可能就在这里。 */
  text?: string | null;
  /** HTML（text/html）：网页复制图片时图片在 img 的 src 里。 */
  html?: string | null;
  /** URI 列表（text/uri-list）：复制链接时的地址。 */
  uri?: string | null;
}

/**
 * 一条图片来源：文件列表给的、图片条目给的，或内嵌 data URL（解码出字节前 file 为 null）。
 * 联合里加一类来源，就是这里加一条——后续来源不要另起一套读取逻辑。
 */
export type ClipboardImage =
  | { source: "file"; file: File }
  | { source: "item"; file: File }
  | { source: "dataUrl"; dataUrl: string; file: File | null };

/** 归一化结果：图片按事件里可确定的顺序排好；opaqueFiles 是「看着像内容却读不到受支持图片」的个数。 */
export interface ClipboardImages {
  images: ClipboardImage[];
  /** 读不到受支持图片的文件个数（资源管理器里复制的文件、取不到字节的图片条目）。 */
  opaqueFiles: number;
  /** 剪贴板里的网络地址个数：应用不抓，只用来给用户一个原因。 */
  remote: number;
  /** 剪贴板内容的样子：决定「没有受支持图片」时给哪句提示。 */
  content: PasteContent;
}

/**
 * 媒体类型 → 扩展名：只认既有格式清单（core/relocate 的 IMAGE_EXTENSIONS）里的那些，不另维护一份 MIME 表。
 * 媒体类型的子类型本身就在清单里（png / jpg / jpeg / webp / gif / bmp / tif / tiff / heic / heif）；
 * 带 x- 前缀的老写法（image/x-tiff）去掉前缀再认一次。
 */
function extensionOf(mime: string): string | null {
  const subtype = mime.slice(mime.indexOf("/") + 1).toLowerCase();
  for (const candidate of [subtype, subtype.replace(/^x-/, "")]) {
    if (IMAGE_EXTENSIONS.includes(candidate)) return candidate;
  }
  return null;
}

/** 一个网络地址：只看形状，绝不访问它。 */
const HTTP_URL = /^https?:\/\//i;

/** 整段文本就是一个网络地址（地址栏复制的链接）：算 URI 类内容，不是散文。 */
const WHOLE_URL = /^https?:\/\/\S+$/;

/** HTML 里的 img 标签：网络图片地址藏在这里（只用来给原因，不去抓）。 */
const IMG_SRC = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * 文本里出现的 data URL：媒体类型到分隔符为止，载荷吃到空白 / 引号 / 尖括号为止。
 * 载荷不能贪心地吃到文末——那样同一段文字里的两张内嵌图片只会认出一张。
 */
const DATA_URL_START = /data:image\/[a-z0-9][a-z0-9!#$&^_.+-]*[;,][^\s"'<>]*/gi;

/**
 * 从一段文本里取出内嵌的图片 data URL（HTML 的 img src 与纯文本里的裸 data URL 都算）。
 * 载荷吃到空白 / 引号 / 尖括号为止：不按 base64 字符集收，坏掉的载荷也要收进来，
 * 否则「解不开」会被当成「没有这张图」，用户拿不到任何原因。
 */
function dataUrlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATA_URL_START)) {
    const raw = m[0];
    const comma = raw.indexOf(",");
    if (comma < 0) continue;
    const meta = raw.slice(0, comma);
    const body = raw.slice(comma + 1);
    const payload = /^[^\s"'<>]*/.exec(body)?.[0] ?? "";
    if (!payload) continue;
    out.push(`${meta},${payload}`);
  }
  return out;
}

/** data URL 的三段：媒体类型、是否 base64、载荷。 */
interface DataUrlParts {
  mime: string;
  base64: boolean;
  /** 载荷在原串里的起点与长度：超限的载荷不必真拷出来。 */
  start: number;
  length: number;
}

/**
 * 解析一个 data URL 的形状：不是图片 data URL 或形状不对时给 null。
 * 只给载荷的位置与长度，不拷载荷——超限的载荷有几百 MB，拷出来本身就白费内存。
 */
function parseDataUrl(url: string): DataUrlParts | null {
  const trimmed = url.trim();
  if (!/^data:image\/[a-z0-9][a-z0-9!#$&^_.+-]*(;[^,]*)?,/i.test(trimmed)) return null;
  const comma = trimmed.indexOf(",");
  const meta = trimmed.slice(0, comma);
  return { mime: meta.slice(5, meta.indexOf(";") < 0 ? undefined : meta.indexOf(";")).toLowerCase(), base64: /;base64(;|$)/i.test(meta), start: comma + 1, length: trimmed.length - comma - 1 };
}

/** HTML 里指向网络地址的图片有几个：只记个数。 */
function remoteImageAddresses(html: string): number {
  let n = 0;
  for (const m of html.matchAll(IMG_SRC)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (HTTP_URL.test(src)) n += 1;
  }
  return n;
}

/**
 * 剪贴板内容的样子：文件 → URI → HTML → 文本 → 空。
 * 有 HTML 内容就算 HTML 类：即使同时带着纯文本，也不是「纯文本」这一种内容类别
 * （#98：内容看似是 HTML 却拿不到受支持图片时要给明确提示，而不是放行）。
 */
function contentKind(contents: ClipboardContents): PasteContent {
  const files = contents.files;
  if (files && files.length > 0) return "file";
  const items = contents.items;
  if (items) {
    for (let i = 0; i < items.length; i++) if (items[i]?.kind === "file") return "file";
  }
  if ((contents.uri ?? "").trim()) return "uri";
  const html = (contents.html ?? "").trim();
  const text = (contents.text ?? "").trim();
  // 整段文本就是一个网络地址：算 URI 类内容（地址栏复制的链接），不是散文。
  if (WHOLE_URL.test(text)) return "uri";
  if (html) return "html";
  if (text) return "text";
  return "none";
}

/**
 * 把剪贴板里的图片读成一份有序的候选集合。
 *
 * 顺序：先文件列表（按列表原序），再图片条目（按条目原序），最后是内嵌 data URL——事件里能确定的顺序就这么多。
 * 读不到内容的（零字节、取不到文件、不是图片）计入 opaqueFiles，交给既有的失败反馈提示。
 * 同一张图经两条途径重复暴露的判定不在这里做：内容比较要读字节，放在 uniqueClipboardImages 里。
 */
export function normalizeClipboardImages(contents: ClipboardContents): ClipboardImages {
  const images: ClipboardImage[] = [];
  let opaqueFiles = 0;

  const files = contents.files;
  for (let i = 0; files && i < files.length; i++) {
    const file = files[i];
    if (file && isImageFile(file) && file.size > 0) {
      images.push({ source: "file", file });
    } else {
      opaqueFiles += 1;
    }
  }

  const items = contents.items;
  for (let i = 0; items && i < items.length; i++) {
    const item = items[i];
    if (!item || item.kind !== "file") continue;
    // 只认真实字节：条目自己声明的 MIME 不作数，取不到内容就是读不到。
    const file = item.getAsFile();
    if (!file || !isImageFile(file) || file.size <= 0) {
      opaqueFiles += 1;
      continue;
    }
    images.push({ source: "item", file });
  }

  // 内嵌 data URL（#114）：HTML 的 img src 与纯文本里的裸 data URL 都算；解码在下一步做。
  const html = contents.html ?? "";
  const text = contents.text ?? "";
  const seenUrls = new Set<string>();
  for (const url of [...dataUrlsIn(html), ...dataUrlsIn(text)]) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    images.push({ source: "dataUrl", dataUrl: url, file: null });
  }

  // 网络地址：只记个数，应用不去抓，也不把地址写进任何用户可见文案。
  // 认不认得出它是不是图片无所谓：应用分不清「没扩展名的图片地址」与「普通链接」，一律不去碰，
  // 但要给用户一个可操作的原因（远程地址 ≠ 没有受支持图片）。
  let remote = remoteImageAddresses(html);
  const uri = (contents.uri ?? "").trim().split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#")) ?? "";
  if (HTTP_URL.test(uri)) remote += 1;
  const plain = text.trim();
  if (HTTP_URL.test(plain) && !plain.includes(" ")) remote += 1;

  const content = contentKind(contents);
  return { images, opaqueFiles, remote, content };
}

/**
 * 文件内容的摘要：读得出字节就用内容摘要，读不出（替身文件没有 arrayBuffer）时退回名字 / 类型 / 大小。
 */
async function contentDigest(file: File): Promise<string> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return `sha256:${await sha256Hex(bytes)}`;
  } catch {
    return `meta:${file.name}\u0000${file.type}\u0000${file.size}`;
  }
}

/**
 * 按内容去重：同一张图经文件列表与图片条目暴露时字节必然相同，用内容摘要判定是不是同一张。
 * 名字、类型、大小相同但内容不同的两张截图不会被误并成一张。
 * 只给「大小相同的候选」算摘要：大小不同必然不是同一张，大文件也不必白算一遍。
 */
export async function uniqueClipboardImages(images: readonly ClipboardImage[]): Promise<ClipboardImage[]> {
  const bySize = new Map<number, number[]>();
  images.forEach((image, index) => {
    const size = image.file?.size;
    if (size === undefined) return;
    const group = bySize.get(size);
    if (group) group.push(index);
    else bySize.set(size, [index]);
  });
  const duplicates = new Set<number>();
  for (const indices of bySize.values()) {
    if (indices.length < 2) continue;
    const digests = await Promise.all(indices.map((index) => contentDigest(images[index].file!)));
    const firstOf = new Map<string, number>();
    digests.forEach((digest, k) => {
      const index = indices[k];
      if (firstOf.has(digest)) duplicates.add(index);
      else firstOf.set(digest, index);
    });
  }
  return images.filter((_, index) => !duplicates.has(index));
}

/** 解码后的图片集合与失败分类。 */
export interface DataUrlOutcome {
  images: ClipboardImage[];
  failures: PasteFailures;
}

/** base64 载荷解出来的字节数：先按长度估，超限就不必真去解。 */
function base64Size(length: number): number {
  return Math.floor((length * 3) / 4);
}

/**
 * 百分号编码载荷的字节数上界：按字符数算（百分号转义 3 个字符还原 1 个字节，
 * 其余字符按 UTF-8 最多 3 字节），只会高估不会低估——宁可早一步拒掉超限的载荷。
 */
function percentSize(length: number): number {
  return length * 3;
}

/** base64 载荷 → 字节；解不了给 null（算失败项）。 */
function base64Bytes(payload: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 百分号编码的载荷 → 字节；解不了给 null。
 * 逐个字节解而不是交给 decodeURIComponent：图片字节不是 UTF-8 文本，
 * %89 之类的转义必须还原成原始字节，交给 decodeURIComponent 会整段失败。
 */
function percentBytes(payload: string): Uint8Array<ArrayBuffer> | null {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === "%") {
      const hex = payload.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) out.push(byte);
  }
  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  bytes.set(out);
  return bytes;
}

/**
 * 把内嵌 data URL 解成真实字节：能解的补上 file，解不开的分类计数，同批其它图片照旧能进链路。
 * 超过单张上限（MAX_PASTE_BYTES）的先按载荷长度拒掉，不去解那么长的 base64，也不把载荷拷出来。
 */
export function decodeClipboardDataUrls(images: readonly ClipboardImage[]): DataUrlOutcome {
  const failures: PasteFailures = { invalid: 0, unsupported: 0, tooLarge: 0 };
  const out: ClipboardImage[] = [];
  let seq = 0;
  for (const image of images) {
    if (image.source !== "dataUrl") {
      out.push(image);
      continue;
    }
    const parts = parseDataUrl(image.dataUrl);
    if (!parts) {
      failures.invalid += 1;
      continue;
    }
    const ext = extensionOf(parts.mime);
    if (!ext) {
      failures.unsupported += 1;
      continue;
    }
    const size = parts.base64 ? base64Size(parts.length) : percentSize(parts.length);
    if (size > MAX_PASTE_BYTES) {
      failures.tooLarge += 1;
      continue;
    }
    const payload = image.dataUrl.trim().slice(parts.start, parts.start + parts.length);
    const bytes = parts.base64 ? base64Bytes(payload) : percentBytes(payload);
    if (!bytes || bytes.length === 0) {
      failures.invalid += 1;
      continue;
    }
    seq += 1;
    out.push({ source: "dataUrl", dataUrl: image.dataUrl, file: new File([bytes], `image-${seq}.${ext}`, { type: parts.mime }) });
  }
  return { images: out, failures };
}

/** 归一化产物里已经带真实字节的图片（data URL 那一类要等解码后才有字节）。 */
export function clipboardImageFiles(images: readonly ClipboardImage[]): File[] {
  return images.flatMap((image) => (image.file ? [image.file] : []));
}
