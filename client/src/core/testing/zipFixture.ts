// 单测用的内存 zip 构造器：覆盖 zipIndex 要认的几种布局（stored / deflate、data descriptor、zip64、UTF-8 文件名）。
// 只在测试里用，可以依赖 node:zlib。
import { crc32, deflateRawSync } from "node:zlib";

export interface FixtureEntry {
  name: string;
  data: Uint8Array | string;
  /** 0 = stored，8 = deflate；其他值原样写进头里（用来造不支持的方法），数据按 stored 写。 */
  method?: number;
  /** 像 Web 导出那样：本地头的 CRC 与大小写 0，真实值写在数据后的 data descriptor 里（标志位 3）。 */
  descriptor?: boolean;
  /** 设标志位 11（UTF-8 文件名）；默认 true。 */
  utf8?: boolean;
  /** 本地头 extra 字段的填充长度：本地头与中央目录的 extra 长度不同时，数据起点必须按本地头算。 */
  localExtra?: number;
}

export interface FixtureOptions {
  /** 中央目录条目带 zip64 extra，EOCD 走 zip64 记录与定位器。 */
  zip64?: boolean;
}

const u16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
};
const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
};
const u64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function buildZip(entries: FixtureEntry[], opts: FixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    offset += b.length;
  };
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? new TextEncoder().encode(entry.data) : entry.data;
    const method = entry.method ?? 0;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = crc32(raw);
    const name = new TextEncoder().encode(entry.name);
    const flags = (entry.descriptor ? 1 << 3 : 0) | (entry.utf8 === false ? 0 : 1 << 11);
    const localOffset = offset;
    const localExtra = new Uint8Array(entry.localExtra ? entry.localExtra + 4 : 0);
    if (entry.localExtra) localExtra.set([...u16(0xcafe), ...u16(entry.localExtra)]);
    push(
      concat([
        u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
        u32(entry.descriptor ? 0 : crc), u32(entry.descriptor ? 0 : body.length), u32(entry.descriptor ? 0 : raw.length),
        u16(name.length), u16(localExtra.length), name, localExtra,
      ]),
    );
    push(body);
    if (entry.descriptor) push(concat([u32(0x08074b50), u32(crc), u32(body.length), u32(raw.length)]));
    const big = opts.zip64 === true;
    const extra = big ? concat([u16(0x0001), u16(24), u64(raw.length), u64(body.length), u64(localOffset)]) : new Uint8Array(0);
    central.push(
      concat([
        u32(0x02014b50), u16(45), u16(big ? 45 : 20), u16(flags), u16(method), u16(0), u16(0), u32(crc),
        u32(big ? 0xffffffff : body.length), u32(big ? 0xffffffff : raw.length),
        u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(big ? 0xffffffff : localOffset),
        name, extra,
      ]),
    );
  }
  const cdOffset = offset;
  const cd = concat(central);
  push(cd);
  if (opts.zip64) {
    const zip64Eocd = offset;
    push(concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cd.length), u64(cdOffset)]));
    push(concat([u32(0x07064b50), u32(0), u64(zip64Eocd), u32(1)]));
    push(concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0)]));
  } else {
    push(concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(cdOffset), u16(0)]));
  }
  return concat(parts);
}
