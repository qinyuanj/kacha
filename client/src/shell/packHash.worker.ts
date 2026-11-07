// 画板包导入里要整条读字节的活跑在这个 Web Worker 里（#62）：File 经 postMessage 传进来（不复制内容）。
// - hash：按条目流式解压并算 sha256，回传进度与每个条目的字节事实（PackEntryFact）。
// - body：去重上传时 deflate 条目的上传体，在这里解压成 Blob 再传回（Blob 按引用传递），解压后的字节不进主线程内存。
// 取消由主线程 terminate()。
import type { PackEntryFact } from "../core/boardPack";
import { entryBody, hashEntries } from "../core/packHash";
import { blobSource, type ZipEntry } from "../core/zipIndex";
import { errorText } from "../core/errors";

export type WorkerRequest = { kind: "hash"; file: File; entries: ZipEntry[] } | { kind: "body"; file: File; entry: ZipEntry };
export type WorkerMessage =
  | { kind: "progress"; done: number; total: number }
  | { kind: "hashed"; facts: PackEntryFact[] }
  | { kind: "body"; body: Blob }
  | { kind: "error"; message: string };

// lib.dom 把 self 标成 Window；Worker 里的 postMessage 只收一个参数。
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null; postMessage(message: WorkerMessage): void };

/** 进度最多每 50 ms 报一次：块很小时不让消息淹没主线程。 */
const PROGRESS_INTERVAL_MS = 50;

scope.onmessage = async (e) => {
  const request = e.data;
  let last = 0;
  try {
    if (request.kind === "body") {
      scope.postMessage({ kind: "body", body: await entryBody(request.file, request.entry) });
      return;
    }
    const facts = await hashEntries(blobSource(request.file), request.entries, (done, total) => {
      const now = performance.now();
      if (now - last < PROGRESS_INTERVAL_MS && done < total) return;
      last = now;
      scope.postMessage({ kind: "progress", done, total });
    });
    scope.postMessage({ kind: "hashed", facts });
  } catch (err) {
    scope.postMessage({ kind: "error", message: errorText(err) });
  }
};
