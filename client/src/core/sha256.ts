// SHA-256：内网 HTTP 不是安全上下文，crypto.subtle 不存在（ADR 0018），用纯 JS 的 @noble/hashes。
// sha256Hex 用于任务目录的摘要（提交文本、参考图），保持 async 以维持原有调用时序；
// sha256Stream 是增量接口，画板包导入按条目流式 hash（#62）用它，不必把整个条目读进内存。
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 先让出一次微任务：调用方依赖摘要期间的异步间隙（runner 的提交守护）。
  await Promise.resolve();
  return bytesToHex(sha256(bytes));
}

export interface Sha256Stream {
  update(chunk: Uint8Array): void;
  /** 结束并返回小写十六进制摘要；之后不能再 update。 */
  hex(): string;
}

export function sha256Stream(): Sha256Stream {
  const h = sha256.create();
  return {
    update: (chunk) => void h.update(chunk),
    hex: () => bytesToHex(h.digest()),
  };
}
