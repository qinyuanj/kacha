import { describe, expect, it } from "vitest";
import { sha256Hex, sha256Stream } from "./sha256";

const hex = (s: string) => new TextEncoder().encode(s);

describe("sha256Hex（纯 JS，HTTP 非安全上下文下 crypto.subtle 不可用）", () => {
  it("已知向量", async () => {
    expect(await sha256Hex(hex(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex(hex("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new Uint8Array([1, 2, 3]))).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  });

  it("增量接口：分块喂入与一次性结果相同", async () => {
    const { createHash } = await import("node:crypto");
    const big = new Uint8Array(300001).map((_, i) => (i * 7) % 253);
    const h = sha256Stream();
    for (let at = 0; at < big.length; at += 65536) h.update(big.subarray(at, at + 65536));
    expect(h.hex()).toBe(createHash("sha256").update(big).digest("hex"));
  });

  it("不依赖 crypto.subtle 且保持异步", async () => {
    const subtle = globalThis.crypto?.subtle;
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a: Uint8Array) => a }, configurable: true });
    try {
      let settled = false;
      const p = sha256Hex(hex("异步")).then((v) => ((settled = true), v));
      expect(settled).toBe(false);
      expect(await p).toHaveLength(64);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: { subtle, getRandomValues: (a: Uint8Array) => a }, configurable: true });
    }
  });
});

