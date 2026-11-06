// 浏览器端基准核心：主线程与 Worker 共用。
import { createSHA256 } from "/nm/hash-wasm/dist/index.esm.js";
import { sha256 as nobleSha256 } from "/nm/@noble/hashes/sha2.js";

export async function makeHasher(kind) {
  if (kind === "noble") return () => { const h = nobleSha256.create(); return { update: (c) => h.update(c), hex: () => Array.from(h.digest(), (b) => b.toString(16).padStart(2, "0")).join("") }; };
  const h = await createSHA256();
  return () => { h.init(); return { update: (c) => h.update(c), hex: () => h.digest("hex") }; };
}

export function makeReader(blob) {
  const u8 = async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());
  async function entries() {
    const tailLen = Math.min(blob.size, 22 + 0xffff);
    const tail = await u8(blob.size - tailLen, blob.size);
    const dv = new DataView(tail.buffer);
    let p = tail.length - 22;
    while (p >= 0 && dv.getUint32(p, true) !== 0x06054b50) p--;
    if (p < 0) throw new Error("EOCD not found");
    const count = dv.getUint16(p + 10, true), cdSize = dv.getUint32(p + 12, true), cdOff = dv.getUint32(p + 16, true);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error("zip64 not implemented in bench");
    const cd = await u8(cdOff, cdOff + cdSize);
    const v = new DataView(cd.buffer), td = new TextDecoder(), out = [];
    for (let q = 0, i = 0; i < count; i++) {
      const n = v.getUint16(q + 28, true), m = v.getUint16(q + 30, true), k = v.getUint16(q + 32, true);
      out.push({ name: td.decode(cd.subarray(q + 46, q + 46 + n)), method: v.getUint16(q + 10, true), csize: v.getUint32(q + 20, true), local: v.getUint32(q + 42, true) });
      q += 46 + n + m + k;
    }
    return out;
  }
  async function stream(e) {
    const h = await u8(e.local, e.local + 30);
    const v = new DataView(h.buffer);
    const start = e.local + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    const raw = blob.slice(start, start + e.csize).stream();
    return e.method === 0 ? raw : raw.pipeThrough(new DecompressionStream("deflate-raw"));
  }
  return { entries, stream };
}

export async function runManual(blob, kind, onTick) {
  const newHash = await makeHasher(kind);
  const r = makeReader(blob);
  const results = {};
  let bytes = 0, chunks = 0, maxChunk = 0;
  const t0 = performance.now();
  for (const e of await r.entries()) {
    if (e.name.endsWith("/")) continue;
    const h = newHash();
    for await (const c of await r.stream(e)) { h.update(c); bytes += c.byteLength; chunks++; maxChunk = Math.max(maxChunk, c.byteLength); onTick?.(); }
    results[e.name] = h.hex();
  }
  return { results, bytes, secs: (performance.now() - t0) / 1000, avgChunk: bytes / chunks, maxChunk };
}

export async function setDigest(results) {
  const s = JSON.stringify(Object.entries(results).sort());
  const h = await makeHasher("wasm");
  const x = h(); x.update(new TextEncoder().encode(s));
  return x.hex().slice(0, 16);
}
