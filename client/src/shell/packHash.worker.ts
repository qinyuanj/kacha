// 画板包导入的 hash 阶段（#62）跑在这个 Web Worker 里：File 经 postMessage 传进来（不复制内容），
// 按条目流式解压并算 sha256，回传进度与每个条目的 { name, sha256, size }。取消由主线程 terminate()。
import { hashEntries } from "../core/packHash";
import { blobSource, type ZipEntry } from "../core/zipIndex";

export type HashRequest = { file: File; entries: ZipEntry[] };
export type HashMessage =
  | { kind: "progress"; done: number; total: number }
  | { kind: "done"; facts: Awaited<ReturnType<typeof hashEntries>> }
  | { kind: "error"; message: string };

// lib.dom 把 self 标成 Window；Worker 里的 postMessage 只收一个参数。
const scope = self as unknown as { onmessage: ((e: MessageEvent<HashRequest>) => void) | null; postMessage(message: HashMessage): void };

/** 进度最多每 50 ms 报一次：块很小时不让消息淹没主线程。 */
const PROGRESS_INTERVAL_MS = 50;

scope.onmessage = async (e) => {
  let last = 0;
  try {
    const facts = await hashEntries(blobSource(e.data.file), e.data.entries, (done, total) => {
      const now = performance.now();
      if (now - last < PROGRESS_INTERVAL_MS && done < total) return;
      last = now;
      scope.postMessage({ kind: "progress", done, total });
    });
    scope.postMessage({ kind: "done", facts });
  } catch (err) {
    scope.postMessage({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
