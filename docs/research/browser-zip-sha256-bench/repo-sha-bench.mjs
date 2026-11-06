// 现有 client/src/core/sha256.ts（一次性、非增量）的吞吐量。Node 24 直接剥离类型加载 .ts。
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const { sha256Hex } = await import(pathToFileURL(process.argv[2]).href);
const SIZE = 64 * 1024 * 1024;
const data = new Uint8Array(randomBytes(SIZE));
await sha256Hex(data.subarray(0, 4 << 20));
let best = Infinity, out;
for (let r = 0; r < 3; r++) {
  const t0 = performance.now();
  out = await sha256Hex(data);
  best = Math.min(best, (performance.now() - t0) / 1000);
}
const ok = out === createHash("sha256").update(data).digest("hex");
console.log(`client/src/core/sha256.ts  ${(SIZE / 1048576 / best).toFixed(0)} MiB/s (64MiB 一次性输入, best of 3) ${ok ? "ok" : "MISMATCH"}`);
