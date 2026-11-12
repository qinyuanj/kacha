// 剪贴板图片归一化（#113）与内嵌图片 data URL 解码（#114）：把原生 paste 事件里的文件列表、图片条目与
// 内嵌图片 data URL 汇成一份有序、去重的图片集合，并给「看着像内容却拿不到受支持图片」一个可操作的原因。
// 同一张图经多条途径重复暴露时只取一次；图片条目只认 getAsFile() 给出的真实字节，不凭 MIME 声明认定成功。
// 远程图片地址只用来给原因：应用绝不主动去抓，也不出现在任何用户可见文案里。
import { MAX_PASTE_BYTES, type PasteContent, type PasteFailures } from "../core/pageInput";
import { IMAGE_EXTENSIONS } from "../core/relocate";
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

/** 归一化结果：图片按事件里可确定的顺序排好；opaque 是「看着像内容却读不到受支持图片」的个数。 */
export interface ClipboardImages {
  images: ClipboardImage[];
  opaque: number;
  /** 剪贴板里只是远程图片地址的个数：应用不抓，只用来给用户一个原因。 */
  remote: number;
  /** 剪贴板内容的样子：决定「没有受支持图片」时给哪句提示。 */
  content: PasteContent;
}

/**
 * 图片指纹：同一张图经文件列表与图片条目暴露时，名字、类型、大小一致，据此去重。
 * 两条途径给的是不同 File 实例，只能靠内容特征判断是不是同一张。
 */
function fingerprint(file: File): string {
  return `${file.name}\u0000${file.type}\u0000${file.size}`;
}

/** 媒体类型 → 扩展名：只认既有格式清单里的那些；svg 之类不在其中，算不受支持。 */
const MIME_EXTENSIONS: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  webp: "webp",
  bmp: "bmp",
  gif: "gif",
  tif: "tif",
  "x-tiff": "tif",
  tiff: "tif",
  heic: "heic",
  heif: "heif",
};

/** 这个媒体类型受支持吗：能落到既有格式清单的扩展名才算。 */
function extensionOf(mime: string): string | null {
  const ext = MIME_EXTENSIONS[mime.slice("image/".length).toLowerCase()];
  return ext && IMAGE_EXTENSIONS.includes(ext) ? ext : null;
}

/** 远程地址看起来是不是一张图片：只看路径后缀，绝不访问地址本身。 */
function looksLikeImageUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return IMAGE_EXTENSIONS.some((ext) => path.endsWith(`.${ext}`));
  } catch {
    return false;
  }
}

/** HTML 里的 img 标签：远程图片地址藏在这里（只用来给原因，不去抓）。 */
const IMG_SRC = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * 文本里出现的 data URL：媒体类型到分隔符为止，载荷吃到空白 / 引号 / 尖括号为止。
 * 载荷不能贪心地吃到文末——那样同一段文字里的两张内嵌图片只会认出一张。
 */
const DATA_URL_START = /data:image\/[a-z0-9][a-z0-9!#$&^_.+-]*[;,][^\s"'<>]*/gi;

/**
 * 从一段文本里取出内嵌的图片 data URL（HTML 的 img src 与纯文本里的裸 data URL 都算）。
 * base64 载荷只吃 base64 字符，百分号编码的载荷吃到空白或引号为止，免得把后面的正文一起吞进来。
 */
function dataUrlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATA_URL_START)) {
    const raw = m[0];
    const comma = raw.indexOf(",");
    if (comma < 0) continue;
    const meta = raw.slice(0, comma);
    const body = raw.slice(comma + 1);
    // 载荷吃到空白 / 引号 / 尖括号为止：不按 base64 字符集收，坏掉的载荷也要收进来，
    // 否则「解不开」会被当成「没有这张图」，用户拿不到任何原因。
    const payload = /^[^\s"'<>]*/.exec(body)?.[0] ?? "";
    if (!payload) continue;
    out.push(`${meta},${payload}`);
  }
  return out;
}

/** 文本本身是不是一串图片 data URL（不是散文）：输入框里粘它按粘图片处理。 */
export function isDataUrlText(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  if (!/^data:image\//i.test(trimmed)) return false;
  const urls = dataUrlsIn(trimmed);
  return urls.length === 1 && urls[0].length === trimmed.length;
}

/** data URL 的三段：媒体类型、是否 base64、载荷。 */
interface DataUrlParts {
  mime: string;
  base64: boolean;
  payload: string;
}

/** 解析一个完整的 data URL；不是图片 data URL 或形状不对时给 null。 */
function parseDataUrl(url: string): DataUrlParts | null {
  const m = /^data:(image\/[a-z0-9][a-z0-9!#$&^_.+-]*)(;[^,]*)?,([\s\S]*)$/i.exec(url.trim());
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: /;base64(;|$)/i.test(m[2] ?? ""), payload: m[3] };
}

/** HTML 里指向远程的图片地址有几个：只记个数。 */
function remoteImageAddresses(html: string): number {
  let n = 0;
  for (const m of html.matchAll(IMG_SRC)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (/^https?:\/\//i.test(src)) n += 1;
  }
  return n;
}

/**
 * 剪贴板内容的样子：文件 → URI → HTML → 文本 → 空。
 * HTML 只有在带 img 标签（或没有纯文本可依）时才算 HTML 类，免得复制一段网页文字就被当成图片内容。
 */
function contentKind(contents: ClipboardContents, htmlHasImage: boolean): PasteContent {
  const files = contents.files;
  if (files && files.length > 0) return "file";
  const items = contents.items;
  if (items) {
    for (let i = 0; i < items.length; i++) if (items[i]?.kind === "file") return "file";
  }
  if ((contents.uri ?? "").trim()) return "uri";
  const html = (contents.html ?? "").trim();
  const text = (contents.text ?? "").trim();
  // 整段文本就是一个 http(s) 地址：算 URI 类内容（地址栏复制的链接），不是散文。
  if (/^https?:\/\/\S+$/.test(text)) return "uri";
  if (html && (htmlHasImage || !text)) return "html";
  if (text) return "text";
  return "none";
}

/**
 * 把剪贴板里的图片读成一份有序、去重的集合。
 *
 * 顺序：先文件列表（按列表原序），再图片条目（按条目原序），最后是内嵌 data URL——事件里能确定的顺序就这么多。
 * 去重：条目里已经由文件列表给出的那张不再算一份；同一条目重复出现也只算一份；同一串 data URL 也只算一份。
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

  // 内嵌 data URL（#114）：HTML 的 img src 与纯文本里的裸 data URL 都算；解码在下一步做。
  const html = contents.html ?? "";
  const text = contents.text ?? "";
  for (const url of [...dataUrlsIn(html), ...dataUrlsIn(text)]) {
    if (seen.has(url)) continue;
    seen.add(url);
    images.push({ source: "dataUrl", dataUrl: url, file: null });
  }

  // 远程图片地址：只记个数，应用不去抓，也不把地址写进任何用户可见文案。
  let remote = remoteImageAddresses(html);
  const uri = (contents.uri ?? "").trim().split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#")) ?? "";
  if (/^https?:\/\//i.test(uri) && looksLikeImageUrl(uri)) remote += 1;
  const plain = (contents.text ?? "").trim();
  if (/^https?:\/\//i.test(plain) && looksLikeImageUrl(plain)) remote += 1;

  const content = contentKind(contents, /<img\b/i.test(html));
  return { images, opaque, remote, content };
}

/** 解码后的图片集合与失败分类。 */
export interface DataUrlOutcome {
  images: ClipboardImage[];
  failures: PasteFailures;
}

/** base64 载荷解出来的字节数：先按长度估，超限就不必真去解。 */
function base64Size(payload: string): number {
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - pad;
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
 * 超过单张上限的先按载荷长度拒掉，不去解那么长的 base64。
 * 上限按参数给（默认单张 64 MiB），测试用小上限就能覆盖超限分支。
 */
export function decodeClipboardDataUrls(images: readonly ClipboardImage[], maxBytes = MAX_PASTE_BYTES): DataUrlOutcome {
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
    const size = parts.base64 ? base64Size(parts.payload) : parts.payload.length;
    if (size > maxBytes) {
      failures.tooLarge += 1;
      continue;
    }
    const bytes = parts.base64 ? base64Bytes(parts.payload) : percentBytes(parts.payload);
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
