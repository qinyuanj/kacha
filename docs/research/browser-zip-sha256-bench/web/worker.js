import { runManual, setDigest } from "./bench-core.js";

onmessage = async ({ data: { file, kind } }) => {
  try {
    const r = await runManual(file, kind);
    postMessage({ ok: true, secs: r.secs, bytes: r.bytes, avgChunk: r.avgChunk, maxChunk: r.maxChunk, set: await setDigest(r.results), n: Object.keys(r.results).length });
  } catch (e) {
    postMessage({ ok: false, error: String(e) });
  }
};
