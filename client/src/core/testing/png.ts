// 测试用 PNG 夹具：固定的 1×1 PNG，以及按尺寸 / 颜色生成的纯色 PNG（e2e 经 e2e/common/boards 转出 png）。
import { deflateSync } from "node:zlib";

/** 1×1 PNG（base64）：需要一张真实、可解码的最小 PNG 时用。 */
export const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** PNG_1X1_BASE64 的字节。共享同一个实例：要改动字节的测试先 slice()。 */
export const PNG_1X1 = Uint8Array.from(atob(PNG_1X1_BASE64), (c) => c.charCodeAt(0));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** 纯色 PNG（base64）。alpha = true 时颜色类型 6（带透明通道），否则 2。 */
export function png(width: number, height: number, opts: { alpha?: boolean; rgb?: [number, number, number] } = {}): string {
  const [r, g, b] = opts.rgb ?? [80, 120, 200];
  const bpp = opts.alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.alpha ? 6 : 2;
  const row = Buffer.alloc(1 + width * bpp);
  for (let x = 0; x < width; x++) row.set(opts.alpha ? [r, g, b, 128] : [r, g, b], 1 + x * bpp);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
