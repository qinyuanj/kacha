import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PACK_CANCELLED } from "./boardPack";
import { entryBody, hashEntries } from "./packHash";
import { buildZip } from "./testing/zipFixture";
import { blobSource, readZipIndex, type ZipEntry } from "./zipIndex";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 31) % 251);

async function indexOf(file: Blob): Promise<ZipEntry[]> {
  const index = await readZipIndex(blobSource(file));
  if (index.kind !== "ok") throw new Error(index.reason);
  return index.entries;
}

describe("按条目流式 hash（#62）", () => {
  const file = new Blob([
    buildZip([
      { name: "a/task.json", data: '{"x":1}', method: 8, descriptor: true },
      { name: "a/result.png", data: big, method: 0, descriptor: true },
      { name: "b/大图.png", data: big, method: 8 },
    ]),
  ]);

  it("stored 与 deflate 条目都按解压后的字节给出 sha256 与大小；进度按字节累计到总量", async () => {
    const entries = await indexOf(file);
    const progress: [number, number][] = [];
    const facts = await hashEntries(blobSource(file), entries, (done, total) => progress.push([done, total]));
    expect(facts).toEqual([
      { name: "a/task.json", sha256: sha('{"x":1}'), size: 7 },
      { name: "a/result.png", sha256: sha(big), size: big.length },
      { name: "b/大图.png", sha256: sha(big), size: big.length },
    ]);
    const total = 7 + 2 * big.length;
    expect(progress.at(-1)).toEqual([total, total]);
    expect(progress.every(([, t]) => t === total)).toBe(true);
    expect(progress.length).toBeGreaterThan(3);
  });

  it("取消后以中止原因（「已取消」）reject，不再读后面的条目", async () => {
    const entries = await indexOf(file);
    const abort = new AbortController();
    const seen: number[] = [];
    const run = hashEntries(blobSource(file), entries, (done) => {
      seen.push(done);
      abort.abort(new Error(PACK_CANCELLED));
    }, abort.signal);
    await expect(run).rejects.toThrow(PACK_CANCELLED);
    expect(Math.max(...seen)).toBeLessThan(7 + big.length);
  });

  it("上传体：stored 条目是文件切片（不复制），deflate 条目是解压后的字节", async () => {
    const entries = await indexOf(file);
    const stored = await entryBody(file, entries[1]);
    expect(stored.size).toBe(big.length);
    expect(sha(new Uint8Array(await stored.arrayBuffer()))).toBe(sha(big));
    const deflated = await entryBody(file, entries[0]);
    expect(await deflated.text()).toBe('{"x":1}');
  });
});
