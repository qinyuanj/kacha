// 浏览器端最小 zip 读取器（#61，调研见 docs/research/browser-zip-sha256）：接在 readRange 端口后面，
// 先读 EOCD 与中央目录拿到每个条目的方法、大小与本地头偏移，读条目时再读本地头算数据起点，按需取字节。
// 只接受 method 0（stored）与 8（deflate，经 DecompressionStream("deflate-raw")），支持 zip64 与 UTF-8 文件名。
// 不靠扫描签名找条目边界：Web 导出的条目都带 data descriptor，大小以中央目录为准。
// 读不了的包（其他方法、加密、分卷、结构异常）返回「需回退」，由调用方改走整包上传、交服务端判定。
import { errorText } from "./errors";

/** 随机读取端口：File 用 Blob.slice 实现，单测用内存字节实现。 */
export interface ZipSource {
  size: number;
  /** 读 [start, end) 的字节；end 不超过 size。 */
  readRange(start: number, end: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  /** 条目名（正斜杠，目录条目以 / 结尾）。 */
  name: string;
  method: 0 | 8;
  compressedSize: number;
  /** 解压后的大小。 */
  size: number;
  crc32: number;
  localHeaderOffset: number;
}

export type ZipIndex = { kind: "ok"; entries: ZipEntry[] } | { kind: "unsupported"; reason: string };

/** 读取器认不了的结构：调用方应回退为整包上传。 */
export class ZipUnsupported extends Error {}

export const blobSource = (blob: Blob): ZipSource => ({
  size: blob.size,
  readRange: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
});

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const LOCAL_HEADER_SIZE = 30;
const CHUNK = 1024 * 1024;

const unsupported = (reason: string): never => {
  throw new ZipUnsupported(reason);
};

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (v: DataView, at: number) => {
  const n = v.getBigUint64(at, true);
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? unsupported("zip64 数值超出范围") : Number(n);
};

async function read(src: ZipSource, start: number, length: number): Promise<Uint8Array> {
  if (start < 0 || length < 0 || start + length > src.size) unsupported("偏移超出文件范围");
  const bytes = await src.readRange(start, start + length);
  if (bytes.length !== length) unsupported("读取长度不符");
  return bytes;
}

/** 中央目录的位置与条目数：从尾部最多 22 + 65535 字节里反向找 EOCD，必要时经 zip64 定位器读 zip64 EOCD。 */
async function locateCentralDirectory(src: ZipSource): Promise<{ offset: number; size: number; count: number }> {
  if (src.size < EOCD_SIZE) unsupported("文件太小，不是 zip");
  const tailStart = Math.max(0, src.size - EOCD_SIZE - MAX_COMMENT);
  const tail = await read(src, tailStart, src.size - tailStart);
  const t = view(tail);
  let at = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (t.getUint32(i, true) === SIG_EOCD && i + EOCD_SIZE + t.getUint16(i + 20, true) === tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) unsupported("找不到中央目录结尾");
  if (t.getUint16(at + 4, true) !== 0 || t.getUint16(at + 6, true) !== 0) unsupported("不支持分卷 zip");
  let count = t.getUint16(at + 10, true);
  let size = t.getUint32(at + 12, true);
  let offset = t.getUint32(at + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locatorAt = tailStart + at - 20;
    const locator = view(await read(src, locatorAt, 20));
    if (locator.getUint32(0, true) !== SIG_ZIP64_LOCATOR) unsupported("缺少 zip64 定位器");
    const record = view(await read(src, u64(locator, 8), 56));
    if (record.getUint32(0, true) !== SIG_ZIP64_EOCD) unsupported("zip64 中央目录结尾损坏");
    count = u64(record, 32);
    size = u64(record, 40);
    offset = u64(record, 48);
  }
  return { offset, size, count };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Uint8Array, flags: number): string {
  // 没有 UTF-8 标志时 zip 规定按 CP437 解码；Rust zip 写的非 ASCII 名都带该标志，这里只认纯 ASCII，其余回退。
  if (!(flags & (1 << 11)) && bytes.some((b) => b >= 0x80)) unsupported("文件名不是 UTF-8");
  try {
    return utf8.decode(bytes);
  } catch {
    return unsupported("文件名不是有效的 UTF-8");
  }
}

/** 读中央目录：每个条目的方法、大小与本地头偏移。读不了时返回「需回退」，不抛错。 */
export async function readZipIndex(src: ZipSource): Promise<ZipIndex> {
  try {
    return { kind: "ok", entries: await centralEntries(src) };
  } catch (e) {
    if (e instanceof ZipUnsupported) return { kind: "unsupported", reason: e.message };
    // 读取端口自身失败（文件被移走等）也交给服务端判定。
    return { kind: "unsupported", reason: errorText(e) };
  }
}

async function centralEntries(src: ZipSource): Promise<ZipEntry[]> {
  const cd = await locateCentralDirectory(src);
  const bytes = await read(src, cd.offset, cd.size);
  const v = view(bytes);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < cd.count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== SIG_CENTRAL) unsupported("中央目录损坏");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc32 = v.getUint32(p + 16, true);
    let compressedSize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const disk = v.getUint16(p + 34, true);
    let localHeaderOffset = v.getUint32(p + 42, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > bytes.length) unsupported("中央目录损坏");
    if (flags & 1) unsupported("不支持加密条目");
    if (method !== 0 && method !== 8) unsupported(`不支持的压缩方法 ${method}`);
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), flags);
    // extra：zip64（0x0001）按固定字段为全 1 的顺序给出 size、compressedSize、offset、disk；
    // Info-ZIP Unicode Path（0x7075）会让服务端换用另一个文件名，回退以免两端名字不一致。
    for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = v.getUint16(x, true);
      const len = v.getUint16(x + 2, true);
      if (id === 0x7075) unsupported("含 Unicode Path extra 的文件名");
      if (id === 0x0001) {
        let f = x + 4;
        const next = () => {
          if (f + 8 > x + 4 + len) unsupported("zip64 extra 损坏");
          const n = u64(v, f);
          f += 8;
          return n;
        };
        if (size === 0xffffffff) size = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
      }
      x += 4 + len;
    }
    if (disk !== 0 && disk !== 0xffff) unsupported("不支持分卷 zip");
    if (method === 0 && compressedSize !== size) unsupported(`stored 条目大小不一致：${name}`);
    entries.push({ name, method: method as 0 | 8, compressedSize, size, crc32, localHeaderOffset });
    p = end;
  }
  return entries;
}

/** 条目数据在文件里的起点：本地头的文件名与 extra 长度可能与中央目录不同，必须按本地头算。 */
export async function dataStart(src: ZipSource, entry: ZipEntry): Promise<number> {
  const header = view(await read(src, entry.localHeaderOffset, LOCAL_HEADER_SIZE));
  if (header.getUint32(0, true) !== SIG_LOCAL) unsupported(`本地头损坏：${entry.name}`);
  const start = entry.localHeaderOffset + LOCAL_HEADER_SIZE + header.getUint16(26, true) + header.getUint16(28, true);
  if (start + entry.compressedSize > src.size) unsupported(`条目超出文件范围：${entry.name}`);
  return start;
}

/**
 * 条目解压后的字节流：按块从 readRange 取压缩数据（不整条读入），deflate 再经 DecompressionStream。
 * 结构异常时以 ZipUnsupported reject；deflate 数据损坏时流以错误结束。逐条目流式 hash 直接消费这个流。
 */
export async function openEntry(src: ZipSource, entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  const start = await dataStart(src, entry);
  const end = start + entry.compressedSize;
  let at = start;
  const raw = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (at >= end) return controller.close();
      const next = Math.min(end, at + CHUNK);
      controller.enqueue(await read(src, at, next - at));
      at = next;
    },
  });
  if (entry.method === 0) return raw;
  // lib.dom 把 DecompressionStream 的输入标成 BufferSource，Uint8Array 是它的子集。
  return raw.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** 整条读出解压后的字节（只用于清单、画板、task.json 这类小条目）。 */
export async function readEntryBytes(src: ZipSource, entry: ZipEntry): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = (await openEntry(src, entry)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
