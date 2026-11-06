// 端到端：从 Blob（fs.openAsBlob，不整体读入）按条目随机读取并算 sha256。
// 用法：node zip-bench.mjs <node_modules> <pack.zip> <mode: manual-wasm|manual-noble|zipjs|fflate-unzip>
import { openAsBlob } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [nm, zipPath, mode] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(join(nm, p)).href);
const blob = await openAsBlob(zipPath);

let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);

async function makeHasher(kind) {
  if (kind === "noble") {
    const { sha256 } = await imp("@noble/hashes/sha2.js");
    return () => { const h = sha256.create(); return { update: (c) => h.update(c), hex: () => Buffer.from(h.digest()).toString("hex") }; };
  }
  const { createSHA256 } = await imp("hash-wasm/dist/index.esm.js");
  const h = await createSHA256();
  return () => { h.init(); return { update: (c) => h.update(c), hex: () => h.digest("hex") }; };
}

// ---- 手写最小读取器：EOCD -> 中央目录 -> 本地头 -> slice 数据区 ----
const u8 = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
async function centralDirectory() {
  const tailLen = Math.min(blob.size, 22 + 0xffff);
  const tail = await u8(blob.size - tailLen, blob.size);
  const dv = new DataView(tail.buffer);
  let p = tail.length - 22;
  while (p >= 0 && dv.getUint32(p, true) !== 0x06054b50) p--;
  if (p < 0) throw new Error("EOCD not found");
  let count = dv.getUint16(p + 10, true), cdSize = dv.getUint32(p + 12, true), cdOff = dv.getUint32(p + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error("zip64 EOCD: 需按 APPNOTE 4.3.14/4.3.15 读 zip64 locator（本基准未实现）");
  const cd = await u8(cdOff, cdOff + cdSize);
  const v = new DataView(cd.buffer);
  const td = new TextDecoder();
  const out = [];
  for (let q = 0, i = 0; i < count; i++) {
    if (v.getUint32(q, true) !== 0x02014b50) throw new Error("bad CD header");
    const method = v.getUint16(q + 10, true), csize = v.getUint32(q + 20, true), size = v.getUint32(q + 24, true);
    const n = v.getUint16(q + 28, true), m = v.getUint16(q + 30, true), k = v.getUint16(q + 32, true);
    const local = v.getUint32(q + 42, true);
    out.push({ name: td.decode(cd.subarray(q + 46, q + 46 + n)), method, csize, size, local });
    q += 46 + n + m + k;
  }
  return out;
}
async function entryStream(e) {
  const h = await u8(e.local, e.local + 30);
  const v = new DataView(h.buffer);
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error("bad local header");
  const start = e.local + 30 + v.getUint16(26, true) + v.getUint16(28, true);
  const raw = blob.slice(start, start + e.csize).stream(); // 惰性，按块读
  if (e.method === 0) return raw;
  if (e.method === 8) return raw.pipeThrough(new DecompressionStream("deflate-raw"));
  throw new Error(`unsupported method ${e.method}`);
}

const results = {};
const t0 = performance.now();
let bytes = 0;

if (mode.startsWith("manual")) {
  const newHash = await makeHasher(mode === "manual-noble" ? "noble" : "wasm");
  const entries = await centralDirectory();
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const h = newHash();
    for await (const chunk of await entryStream(e)) { h.update(chunk); bytes += chunk.byteLength; }
    results[e.name] = h.hex();
  }
} else if (mode === "zipjs") {
  const zip = await imp("@zip.js/zip.js/index.js");
  zip.configure({ useWebWorkers: false });
  const newHash = await makeHasher("wasm");
  const reader = new zip.ZipReader(new zip.BlobReader(blob));
  for (const e of await reader.getEntries()) {
    if (e.directory) continue;
    const h = newHash();
    await e.getData(new WritableStream({ write(c) { h.update(c); bytes += c.byteLength; } }));
    results[e.filename] = h.hex();
  }
  await reader.close();
} else if (mode === "fflate-unzip") {
  // fflate 流式 Unzip 只能顺序 push 整个文件，没有按 offset 随机读取。
  const { Unzip, UnzipInflate } = await imp("fflate/esm/browser.js");
  const newHash = await makeHasher("wasm");
  const pending = [];
  const un = new Unzip((f) => {
    const h = newHash();
    pending.push(new Promise((res, rej) => {
      f.ondata = (err, c, final) => { if (err) return rej(err); h.update(c); bytes += c.byteLength; if (final) { results[f.name] = h.hex(); res(); } };
    }));
    f.start();
  });
  un.register(UnzipInflate);
  for await (const c of blob.stream()) un.push(c);
  un.push(new Uint8Array(0), true);
  await Promise.all(pending);
}

const secs = (performance.now() - t0) / 1000;
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().rss);

// 校验：同一份 hash 用 Python 解出的内容另算（见 verify.py）；这里只打印摘要供比对
const digest = createHash("sha256").update(JSON.stringify(Object.entries(results).sort())).digest("hex").slice(0, 16);
console.log(`${mode.padEnd(14)} entries=${Object.keys(results).length} bytes=${(bytes / 1048576).toFixed(0)}MiB time=${secs.toFixed(2)}s ` +
  `throughput=${(bytes / 1048576 / secs).toFixed(0)}MiB/s peakRSS=${(peak / 1048576).toFixed(0)}MiB file=${(blob.size / 1048576).toFixed(0)}MiB set=${digest}`);
