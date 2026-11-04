import { describe, expect, it } from "vitest";
import { newId } from "./ids";

describe("newId（非安全上下文没有 crypto.randomUUID）", () => {
  it("生成 RFC 4122 v4 形态的 id，且不依赖 randomUUID", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (a: Uint8Array<ArrayBuffer>) => original.getRandomValues(a) },
      configurable: true,
    });
    try {
      const id = newId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(new Set(Array.from({ length: 200 }, newId)).size).toBe(200);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});
