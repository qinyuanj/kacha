// base64 与字节的互转（#137）：桌面壳的剪贴板与本地文件读写共用这一份。
import { describe, expect, it } from "vitest";
import { base64Of, base64ToBytes } from "./base64";

describe("base64", () => {
  it("字节转 base64：与 btoa 的结果一致", () => {
    expect(base64Of(new Uint8Array([65, 66]))).toBe(btoa("AB"));
  });

  it("base64 转字节：还原成原来的值", () => {
    expect([...base64ToBytes(btoa("AB"))]).toEqual([65, 66]);
  });

  it("超过一块（0x8000）的字节照样拼对：分块拼接不漏不掉", () => {
    const bytes = new Uint8Array(0x8000 + 3).fill(7);
    const text = base64Of(bytes);
    expect(base64ToBytes(text)).toEqual(bytes);
  });
});
