// 两个 e2e project 共用的夹具：PNG 生成与画板 JSON 构造（不涉及假壳或服务端）。
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";

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

type Json = Record<string, unknown>;

export const promptNode = (id: string, text: string, pos: [number, number] = [0, 0]) => ({ id, type: "prompt", pos, size: [240, 140], text });
export const referenceNode = (id: string, path: string, pos: [number, number] = [0, 200]) => ({
  id, type: "reference", pos, size: [200, 200], path, sha256: "0".repeat(64), display_name: path.split("/").pop(),
});
export const taskNode = (id: string, over: Json = {}, pos: [number, number] = [400, 0]) => ({
  id, type: "task", pos, size: [320, 360], model: "qwen-image-3.0-pro",
  size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
  image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...over,
});
export const edge = (from: string, to: string, port: string, over: Json = {}) => ({ from: [from, "out"], to: [to, port], source_layer: null, region: null, ...over });

export function board(title: string, nodes: unknown[], edges: unknown[]) {
  return JSON.stringify({ format_version: 1, title, viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges }, null, 2);
}

export const MODELS = ["qwen-image-3.0-pro", "qwen-image-3.0", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-lite-260128", "doubao-seedream-5-0-flash-260915"];

export const task = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
