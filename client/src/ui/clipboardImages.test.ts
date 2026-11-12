// 剪贴板图片归一化与内嵌 data URL 解码（#113 / #114）：
// 文件、图片条目与内嵌 data URL 汇成同一份有序集合；解不开的分类计数；远程地址只记个数、不去抓。
import { describe, expect, it } from "vitest";
import { decodeClipboardDataUrls, isDataUrlText, normalizeClipboardImages } from "./clipboardImages";

/** 1×1 的 PNG（真字节，base64）。 */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 图片 data URL。 */
const pngUrl = (b64 = PNG_B64): string => `data:image/png;base64,${b64}`;

/** 文件替身：粘贴逻辑只经它看名字、MIME 与字节数。 */
const fileOf = (name: string, type: string, size = 1024): File => ({ name, type, size }) as unknown as File;
/** kind === "file" 的图片条目替身。 */
const fileItem = (file: File | null, type = file?.type ?? "image/png") => ({ kind: "file", type, getAsFile: () => file });

describe("内嵌图片 data URL 的归一化", () => {
  it("HTML 里 img 的 src 是 data URL：收进图片集合，排在意料的位置", () => {
    const r = normalizeClipboardImages({ html: `<img src="${pngUrl()}" width="1">` });
    expect(r.images.map((i) => i.source)).toEqual(["dataUrl"]);
    expect(r.images[0]).toMatchObject({ source: "dataUrl", dataUrl: pngUrl(), file: null });
  });

  it("纯文本里就是一段图片 data URL：收进图片集合", () => {
    const r = normalizeClipboardImages({ text: pngUrl() });
    expect(r.images.map((i) => i.source)).toEqual(["dataUrl"]);
  });

  it("同一串 data URL 在 HTML 与文本里各出现一次：只算一张", () => {
    const r = normalizeClipboardImages({ html: `<img src="${pngUrl()}">`, text: pngUrl() });
    expect(r.images).toHaveLength(1);
  });

  it("顺序：文件列表 → 图片条目 → 内嵌 data URL", () => {
    const r = normalizeClipboardImages({ files: [fileOf("a.png", "image/png")], items: [fileItem(fileOf("b.png", "image/png"))], text: pngUrl() });
    expect(r.images.map((i) => i.source)).toEqual(["file", "item", "dataUrl"]);
  });

  it("文本本身是一串图片 data URL：认出来（输入框里粘它按粘图片处理）", () => {
    expect(isDataUrlText(pngUrl())).toBe(true);
    expect(isDataUrlText(`看看这张图 ${pngUrl()}`)).toBe(false);
    expect(isDataUrlText("一段普通文字")).toBe(false);
    expect(isDataUrlText(null)).toBe(false);
  });
});

describe("data URL 解码", () => {
  it("有效 data URL：解出真实字节，类型与后缀对得上", () => {
    const r = decodeClipboardDataUrls(normalizeClipboardImages({ text: pngUrl() }).images);
    expect(r.failures).toEqual({ invalid: 0, unsupported: 0, tooLarge: 0 });
    expect(r.images).toHaveLength(1);
    const file = r.images[0].file!;
    expect(file.type).toBe("image/png");
    expect(file.name.endsWith(".png")).toBe(true);
    expect(file.size).toBeGreaterThan(0);
  });

  it("解出来的字节与原始载荷一致", async () => {
    const r = decodeClipboardDataUrls(normalizeClipboardImages({ text: pngUrl() }).images);
    const bytes = new Uint8Array(await r.images[0].file!.arrayBuffer());
    expect([...bytes]).toEqual([...new Uint8Array(atob(PNG_B64).split("").map((c) => c.charCodeAt(0)))]);
  });

  it("百分号编码的载荷也能解", () => {
    const r = decodeClipboardDataUrls(normalizeClipboardImages({ text: "data:image/png,%89PNG" }).images);
    expect(r.failures.invalid).toBe(0);
    expect(r.images[0].file?.size).toBeGreaterThan(0);
  });

  /**
   * 失败分类：每类一句用户可见原因，同批其它图片照旧能进链路。
   * 表驱动：给一组 data URL，期望每类失败各几个、能解出几张。
   */
  const CASES: { name: string; url: string; invalid: number; unsupported: number; tooLarge: number; ok: number }[] = [
    { name: "载荷不是合法 base64：算解不开", url: "data:image/png;base64,!!!!", invalid: 1, unsupported: 0, tooLarge: 0, ok: 0 },
    { name: "载荷为空：算解不开", url: "data:image/png;base64,", invalid: 1, unsupported: 0, tooLarge: 0, ok: 0 },
    { name: "格式不受支持（svg）：算格式不支持", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", invalid: 0, unsupported: 1, tooLarge: 0, ok: 0 },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const r = decodeClipboardDataUrls([{ source: "dataUrl", dataUrl: c.url, file: null }]);
      expect(r.failures).toEqual({ invalid: c.invalid, unsupported: c.unsupported, tooLarge: c.tooLarge });
      expect(r.images).toHaveLength(c.ok);
    });
  }

  it("超过单张上限：算超限，不去解那么长的载荷", () => {
    // 上限按参数给：1 字节，PNG 载荷解出来远大于 1。
    const r = decodeClipboardDataUrls([{ source: "dataUrl", dataUrl: pngUrl(), file: null }], 1);
    expect(r.failures.tooLarge).toBe(1);
    expect(r.images).toHaveLength(0);
  });

  it("同批里解不开的那张不影响其它图片：可读的那张照旧进链路", () => {
    const images = normalizeClipboardImages({ text: `data:image/png;base64,!!!!
${pngUrl()}` }).images;
    const r = decodeClipboardDataUrls(images);
    expect(r.failures.invalid).toBe(1);
    expect(r.images.filter((i) => i.file)).toHaveLength(1);
  });
});

describe("远程图片地址", () => {
  it("HTML 里的远程图片：只记个数，不当成图片", () => {
    const r = normalizeClipboardImages({ html: '<img src="https://example.com/a.png">' });
    expect(r.images).toHaveLength(0);
    expect(r.remote).toBe(1);
  });

  it("地址与鉴权信息不会出现在归一化结果里", () => {
    const url = "https://example.com/a.png?token=secret";
    const r = normalizeClipboardImages({ html: `<img src="${url}">` });
    expect(JSON.stringify(r)).not.toContain("example.com");
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("文本就是一张远程图片地址：算 URI 类内容，不是图片，也记成远程", () => {
    const r = normalizeClipboardImages({ text: "https://example.com/a.png" });
    expect(r.images).toHaveLength(0);
    expect(r.content).toBe("uri");
    expect(r.remote).toBe(1);
  });

  it("远程地址没有受支持图片：内容归类为 HTML / URI，而不是文本", () => {
    expect(normalizeClipboardImages({ html: '<img src="https://example.com/a.png">' }).content).toBe("html");
    expect(normalizeClipboardImages({ uri: "https://example.com/a.png" }).content).toBe("uri");
  });
});

describe("内容归类", () => {
  it("有文件：算文件类内容", () => {
    expect(normalizeClipboardImages({ files: [fileOf("a.png", "image/png")] }).content).toBe("file");
  });

  it("只有图片条目：也算文件类内容", () => {
    expect(normalizeClipboardImages({ items: [fileItem(fileOf("a.png", "image/png"))] }).content).toBe("file");
  });

  it("空剪贴板：算空", () => {
    expect(normalizeClipboardImages({}).content).toBe("none");
  });

  it("普通纯文本：算文本", () => {
    expect(normalizeClipboardImages({ text: "一段说明" }).content).toBe("text");
  });

  it("HTML 里没有图片、也有一段纯文本：算文本（别把复制的网页文字当成图片内容）", () => {
    expect(normalizeClipboardImages({ html: "<p>一段说明</p>", text: "一段说明" }).content).toBe("text");
  });
});
