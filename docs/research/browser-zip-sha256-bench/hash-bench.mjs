// sha256 吞吐量粗测：256 MiB 随机数据，按 1 MiB / 64 KiB 块增量 update。
// 用法：node hash-bench.mjs <deps/node_modules 绝对路径>
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const nm = process.argv[2];
const imp = (p) => import(pathToFileURL(join(nm, p)).href);
const { sha256: nobleSha256 } = await imp("@noble/hashes/sha2.js");
const { createSHA256 } = await imp("hash-wasm/dist/index.esm.js");

const TOTAL = 256 * 1024 * 1024;
const data = randomBytes(TOTAL);
const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const wasm = await createSHA256();
const impls = {
  "node:crypto (原生 OpenSSL，参照上限)": () => {
    let h = createHash("sha256");
    return { update: (c) => h.update(c), digest: () => h.digest("hex") };
  },
  "hash-wasm 4.12.0 (WASM)": () => {
    wasm.init();
    return { update: (c) => wasm.update(c), digest: () => wasm.digest("hex") };
  },
  "@noble/hashes 2.4.0 (纯 JS)": () => {
    const h = nobleSha256.create();
    return { update: (c) => h.update(c), digest: () => Buffer.from(h.digest()).toString("hex") };
  },
};

for (const chunk of [1024 * 1024, 64 * 1024]) {
  let ref;
  for (const [name, make] of Object.entries(impls)) {
    // 预热一轮
    { const h = make(); h.update(view.subarray(0, 8 * 1024 * 1024)); h.digest(); }
    const runs = [];
    let out;
    for (let r = 0; r < 3; r++) {
      const t0 = process.hrtime.bigint();
      const h = make();
      for (let o = 0; o < TOTAL; o += chunk) h.update(view.subarray(o, o + chunk));
      out = h.digest();
      runs.push(Number(process.hrtime.bigint() - t0) / 1e9);
    }
    ref ??= out;
    const best = Math.min(...runs);
    console.log(`chunk=${chunk / 1024}KiB  ${name.padEnd(36)} ${(TOTAL / 1048576 / best).toFixed(0).padStart(5)} MiB/s  (best of 3, ${best.toFixed(2)}s)  ${out === ref ? "ok" : "MISMATCH"}`);
  }
}
