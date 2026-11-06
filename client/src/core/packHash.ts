// 画板包条目的内容事实与上传体（#62）：按条目流式解压并算 sha256（浏览器里跑在 Web Worker，见 shell/packHash.ts），
// 以及去重上传时某个条目的请求体。读取都接在 zipIndex 后面，不把整个包读进内存。
import { sha256Stream } from "./sha256";
import { blobSource, dataStart, openEntry, readEntryBytes, type ZipEntry, type ZipSource } from "./zipIndex";

/** 一个条目解压后的长度与 sha256。 */
export interface EntryHash {
  name: string;
  sha256: string;
  size: number;
}

/**
 * 依次读出每个条目（解压后）算 sha256；progress 按已读的解压后字节报告，总量 = 各条目 size 之和。
 * signal 中止时以它的 reason reject（调用方传「已取消」），不再读后面的字节。
 */
export async function hashEntries(src: ZipSource, entries: ZipEntry[], progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<EntryHash[]> {
  const total = entries.reduce((n, e) => n + e.size, 0);
  const stopped = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  };
  let done = 0;
  const out: EntryHash[] = [];
  for (const entry of entries) {
    stopped();
    const reader = (await openEntry(src, entry)).getReader();
    const h = sha256Stream();
    let size = 0;
    try {
      for (;;) {
        stopped();
        const { done: end, value } = await reader.read();
        if (end) break;
        h.update(value);
        size += value.length;
        done += value.length;
        progress(done, total);
      }
    } finally {
      reader.releaseLock();
    }
    out.push({ name: entry.name, sha256: h.hex(), size });
  }
  return out;
}

/** 去重上传时一个条目的请求体：stored 条目直接是文件切片（不复制、流式发送）；deflate 条目解压成字节。 */
export async function entryBody(file: Blob, entry: ZipEntry): Promise<Blob> {
  if (entry.method === 0) {
    const start = await dataStart(blobSource(file), entry);
    return file.slice(start, start + entry.size);
  }
  return new Blob([(await readEntryBytes(blobSource(file), entry)) as Uint8Array<ArrayBuffer>]);
}
