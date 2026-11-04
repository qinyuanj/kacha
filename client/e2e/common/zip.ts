// e2e 读取下载的 zip：只支持服务端打出的普通条目（stored / deflate），不引入额外依赖。
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  bytes: Buffer;
}

/** 从中央目录取条目，逐条按本地头读内容。 */
export function unzip(buf: Buffer): ZipEntry[] {
  // EOCD：签名 0x06054b50，从尾部找。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 zip：没有中央目录");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("本地头损坏");
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressed);
    out.push({ name, bytes: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
