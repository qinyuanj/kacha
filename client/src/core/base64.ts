// base64 与字节的互转（#137）：桌面壳的剪贴板与本地文件读写共用同一份实现。
// 跨 IPC 的字节一律走 base64（Go 的 []byte 在 JSON 里就是 base64 字符串），这里只做转换。
/** 字节 → base64。 */
export function base64Of(bytes: Uint8Array): string {
  // 分块拼，避免大图时把整个字符串塞进 apply 的参数表。
  const chunk = 0x8000;
  const parts: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunk)));
    offset += chunk;
  }
  return btoa(parts.join(""));
}

/** base64 文本 → 字节。 */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
