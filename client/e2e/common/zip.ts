// 在 Node 侧读 zip 的条目名与内容（画板包下载断言用）：解析中央目录，不依赖第三方库。
// 只支持本仓库画板包用到的 deflate / store 与无加密条目。
import { inflateRawSync } from "node:zlib";

interface Entry {
  name: string;
  method: number;
  compressed: number;
  offset: number;
}

function centralEntries(buf: Buffer): Entry[] {
  // End of Central Directory：从尾部找签名 0x06054b50。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到中央目录结尾）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    out.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"), method, compressed, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipNames(buf: Buffer): string[] {
  return centralEntries(buf).map((e) => e.name);
}

export function zipText(buf: Buffer, name: string): string {
  return zipBytes(buf, name).toString("utf8");
}

export function zipBytes(buf: Buffer, name: string): Buffer {
  const entry = centralEntries(buf).find((e) => e.name === name);
  if (!entry) throw new Error(`包内没有条目 ${name}`);
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error("本地文件头损坏");
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressed);
  return entry.method === 8 ? inflateRawSync(data) : data;
}
