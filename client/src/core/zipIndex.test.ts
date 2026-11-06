import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildZip, type FixtureEntry, type FixtureOptions } from "./testing/zipFixture";
import { blobSource, readEntryBytes, readZipIndex, type ZipSource } from "./zipIndex";

/** 内存 readRange 端口：记下读过的字节数，用来确认不会整包读入。 */
function memory(bytes: Uint8Array): ZipSource & { bytesRead: number } {
  const src = {
    size: bytes.length,
    bytesRead: 0,
    readRange: async (start: number, end: number) => {
      src.bytesRead += end - start;
      return bytes.slice(start, end);
    },
  };
  return src;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function readAll(entries: FixtureEntry[], opts?: FixtureOptions) {
  const src = memory(buildZip(entries, opts));
  const index = await readZipIndex(src);
  if (index.kind !== "ok") throw new Error(`应能读取：${index.reason}`);
  const out: Record<string, string> = {};
  for (const e of index.entries) out[e.name] = text(await readEntryBytes(src, e));
  return { index, out, src };
}

describe("zip 读取器", () => {
  const json = JSON.stringify({ pack_format_version: 1, boards: ["画板/甲.ugcboard.json"] });
  const jsonBytes = new TextEncoder().encode(json).length;

  it("stored 与 deflate 条目：按中央目录列出名字、方法与大小，读出原始内容", async () => {
    const { index, out } = await readAll([
      { name: "manifest.json", data: json, method: 8 },
      { name: "a/result.png", data: "PNGDATA", method: 0 },
    ]);
    expect(index.entries.map(({ name, method, size }) => ({ name, method, size }))).toEqual([
      { name: "manifest.json", method: 8, size: jsonBytes },
      { name: "a/result.png", method: 0, size: 7 },
    ]);
    expect(out).toEqual({ "manifest.json": json, "a/result.png": "PNGDATA" });
  });

  it("带 data descriptor（与 Web 导出一致，本地头里大小为 0）：按中央目录的大小读，不截断", async () => {
    // 内容里刻意放进 data descriptor / 本地头签名字节：按签名扫描的读取器会在这里截断。
    const tricky = new Uint8Array([1, 2, 0x50, 0x4b, 0x07, 0x08, 3, 0x50, 0x4b, 0x03, 0x04, 9]);
    const src = memory(
      buildZip([
        { name: "manifest.json", data: json, method: 8, descriptor: true },
        { name: "a/result.png", data: tricky, method: 0, descriptor: true },
      ]),
    );
    const index = await readZipIndex(src);
    if (index.kind !== "ok") throw new Error(index.reason);
    expect(text(await readEntryBytes(src, index.entries[0]))).toBe(json);
    expect(await readEntryBytes(src, index.entries[1])).toEqual(tricky);
  });

  it("本地头的 extra 长度与中央目录不同：数据起点按本地头算", async () => {
    const { out } = await readAll([{ name: "a.txt", data: "hello", localExtra: 12 }]);
    expect(out).toEqual({ "a.txt": "hello" });
  });

  it("zip64：经 zip64 EOCD 定位中央目录，大小与偏移取自 zip64 extra", async () => {
    const { index, out } = await readAll(
      [
        { name: "manifest.json", data: json, method: 8 },
        { name: "b.bin", data: "zip64 body" },
      ],
      { zip64: true },
    );
    expect(index.entries.map((e) => [e.name, e.size])).toEqual([
      ["manifest.json", jsonBytes],
      ["b.bin", 10],
    ]);
    expect(out["b.bin"]).toBe("zip64 body");
  });

  it("UTF-8 文件名（标志位 11）按 UTF-8 解码", async () => {
    const { out } = await readAll([{ name: "画板/千问测试.ugcboard.json", data: "{}", method: 8 }]);
    expect(Object.keys(out)).toEqual(["画板/千问测试.ugcboard.json"]);
  });

  it("只读中央目录与所需条目，不整包读入", async () => {
    const big = new Uint8Array(4 * 1024 * 1024);
    const src = memory(buildZip([{ name: "manifest.json", data: json, method: 8 }, { name: "big.bin", data: big }]));
    const index = await readZipIndex(src);
    if (index.kind !== "ok") throw new Error(index.reason);
    await readEntryBytes(src, index.entries[0]);
    expect(src.bytesRead).toBeLessThan(200 * 1024);
  });

  it("File 也能当 readRange 端口：Blob.slice 按需读取", async () => {
    const file = new File([buildZip([{ name: "a.txt", data: "via blob", method: 8, descriptor: true }])], "x.ugcpack");
    const src = blobSource(file);
    const index = await readZipIndex(src);
    if (index.kind !== "ok") throw new Error(index.reason);
    expect(text(await readEntryBytes(src, index.entries[0]))).toBe("via blob");
  });

  describe("读不了时返回「需回退」而不是抛错", () => {
    const cases: [string, Uint8Array][] = [
      ["压缩方法不是 0 / 8", buildZip([{ name: "manifest.json", data: json }, { name: "a.bin", data: "bz", method: 12 }])],
      ["没有 UTF-8 标志的非 ASCII 文件名（CP437）", buildZip([{ name: "画板/甲.json", data: "{}", utf8: false }])],
      ["不是 zip", new TextEncoder().encode("definitely not a zip file")],
      ["空文件", new Uint8Array(0)],
    ];
    for (const [title, bytes] of cases) {
      it(title, async () => {
        expect(await readZipIndex(memory(bytes))).toMatchObject({ kind: "unsupported", reason: expect.any(String) });
      });
    }

    it("加密条目（标志位 0）", async () => {
      const bytes = buildZip([{ name: "a.txt", data: "x" }]);
      // 改中央目录里的通用标志位：置加密位。
      const view = new DataView(bytes.buffer);
      const cd = view.getUint32(bytes.length - 22 + 16, true);
      view.setUint16(cd + 8, view.getUint16(cd + 8, true) | 1, true);
      expect(await readZipIndex(memory(bytes))).toMatchObject({ kind: "unsupported" });
    });
  });

  it("仓库里的真实画板包（Rust zip 写出的 0.2.0 / 0.3.2 桌面包、手写的 v2 包）都能读出条目与清单", async () => {
    const packs = [
      "../contracts/smoke/board-pack/豆包测试.ugcpack",
      "fixtures/packs/v0.3.2-flash-layers.ugcpack",
      "fixtures/packs/v2-duplicates.ugcpack",
    ];
    for (const pack of packs) {
      const src = memory(new Uint8Array(readFileSync(pack)));
      const index = await readZipIndex(src);
      if (index.kind !== "ok") throw new Error(`${pack}: ${index.reason}`);
      const manifest = index.entries.find((e) => e.name === "manifest.json")!;
      expect(JSON.parse(text(await readEntryBytes(src, manifest))).pack_format_version, pack).toBeGreaterThanOrEqual(1);
    }
  });
});
