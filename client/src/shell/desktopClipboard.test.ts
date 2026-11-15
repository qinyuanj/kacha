// 系统剪贴板的页面侧转换（#129）：Go 侧快照 → 界面要的 ClipboardContent。
// 纯函数：不碰 DOM、不起 MyGo runtime、不发请求。
import { describe, expect, it } from "vitest";
import { base64Of } from "../core/base64";
import { clipboardContentOf, extensionOf } from "./desktopClipboard";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const snapshot = (over: Partial<Parameters<typeof clipboardContentOf>[0]> = {}) => ({ kind: "empty", text: "", images: [], reason: "", formats: [], ...over });

describe("快照转换", () => {
  it("类别原样折过来：Go 侧的 Kind 与页面的一致", () => {
    for (const kind of ["mark", "images", "text", "empty", "unsupported", "busy"] as const) {
      expect(clipboardContentOf(snapshot({ kind })).kind).toBe(kind);
    }
  });

  it("没见过的类别按「有内容但用不了」处理，不静默丢", () => {
    expect(clipboardContentOf(snapshot({ kind: "别的" })).kind).toBe("unsupported");
  });

  it("原因码折成页面枚举；没见过的按 failed", () => {
    expect(clipboardContentOf(snapshot({ kind: "unsupported", reason: "files" })).reason).toBe("files");
    expect(clipboardContentOf(snapshot({ kind: "busy", reason: "changed" })).reason).toBe("changed");
    expect(clipboardContentOf(snapshot({ kind: "busy", reason: "别的" })).reason).toBe("failed");
  });

  it("空文本是 null 而不是空串：分派据此判断「有没有文本」", () => {
    expect(clipboardContentOf(snapshot()).text).toBeNull();
    expect(clipboardContentOf(snapshot({ kind: "text", text: "一段文字" })).text).toBe("一段文字");
  });

  it("base64 的 PNG 还原成 image/png 的 File：既有导入链路认得它", () => {
    const content = clipboardContentOf(snapshot({ kind: "images", images: [base64Of(PNG)] }));
    expect(content.images).toHaveLength(1);
    expect(content.images[0].type).toBe("image/png");
    expect(content.images[0].size).toBe(PNG.length);
  });

  it("多图保持剪贴板里的顺序", () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6, 7]);
    const content = clipboardContentOf(snapshot({ kind: "images", images: [base64Of(first), base64Of(second)] }));
    expect(content.images.map((f) => f.size)).toEqual([first.length, second.length]);
  });

  it("文件的原因码同时记进 readFailureCount：走「改为拖入」那条提示", () => {
    expect(clipboardContentOf(snapshot({ kind: "unsupported", reason: "files" })).readFailureCount).toBe(1);
    expect(clipboardContentOf(snapshot({ kind: "images", images: [base64Of(PNG)] })).readFailureCount).toBe(0);
  });

  it("落盘扩展名按图片格式；剪贴板里的 PNG 就是 png", () => {
    expect(extensionOf(new File([], "a.png", { type: "image/png" }))).toBe("png");
    expect(extensionOf(new File([], "a.jpg", { type: "image/jpeg" }))).toBe("jpg");
    expect(extensionOf(new File([], "a.webp", { type: "image/webp" }))).toBe("webp");
    expect(extensionOf(new File([], "a.gif", { type: "image/gif" }))).toBe("gif");
  });
});
