// SHA-256 用于任务记录与参考图摘要；不依赖 WebView 的 crypto.subtle。
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 先让出一次微任务：调用方依赖摘要期间的异步间隙（runner 的提交守护）。
  await Promise.resolve();
  return bytesToHex(sha256(bytes));
}
