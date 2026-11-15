// 系统剪贴板分派（#129）：桌面壳从系统剪贴板读到的内容，决定一个 Ctrl+V 走哪条路。
// 纯逻辑：不碰 DOM、不起 MyGo runtime、不发请求。真正的读取在壳端口的 readClipboard。
import { describe, expect, it } from "vitest";
import { dispatchClipboardPaste, type ClipboardContent } from "./clipboardDispatch";
import type { PasteContext } from "./pageInput";

const AT: [number, number] = [10, 20];

const context = (over: Partial<PasteContext> = {}): PasteContext => ({
  board: true,
  readOnly: false,
  modal: false,
  textFocus: false,
  hasNodeClip: false,
  at: AT,
  ...over,
});

const png = (name = "shot.png"): File => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

const content = (over: Partial<ClipboardContent> = {}): ClipboardContent => ({
  kind: "empty",
  text: null,
  images: [],
  reason: null,
  readFailureCount: 0,
  ...over,
});

const MARK = "kacha:clip:v1:2";

describe("标记与图片的优先级", () => {
  it("剪贴板里是节点标记、应用内也有节点：粘节点", () => {
    expect(dispatchClipboardPaste(content({ kind: "mark", text: MARK }), context({ hasNodeClip: true }))).toEqual({ kind: "pasteNodes" });
  });

  it("剪贴板里是节点标记、应用内剪贴板已空：拒绝并说明要重新复制，不静默", () => {
    expect(dispatchClipboardPaste(content({ kind: "mark", text: MARK }), context())).toEqual({ kind: "refuse", reason: "staleNodeClip" });
  });

  it("标记与图片同时存在时标记优先：复制节点后立刻粘贴不会粘出旧截图", () => {
    const snapshot = content({ kind: "mark", text: MARK, images: [png()] });
    expect(dispatchClipboardPaste(snapshot, context({ hasNodeClip: true }))).toEqual({ kind: "pasteNodes" });
  });

  it("截图后粘贴不会粘出旧节点：只有图片时按图片走", () => {
    const snapshot = content({ kind: "images", images: [png()] });
    expect(dispatchClipboardPaste(snapshot, context({ hasNodeClip: true }))).toEqual({ kind: "importImages", at: AT });
  });

  it("只读画板上粘节点标记：拒绝，理由与归档只读一致", () => {
    expect(dispatchClipboardPaste(content({ kind: "mark", text: MARK }), context({ readOnly: true, hasNodeClip: true }))).toEqual({ kind: "refuse", reason: "readOnly" });
  });
});

describe("图片", () => {
  it("一张图：落成参考图节点，落点原样传下去", () => {
    expect(dispatchClipboardPaste(content({ kind: "images", images: [png()] }), context())).toEqual({ kind: "importImages", at: AT });
  });

  it("多张图：一次分派、落点只有一个，顺序由快照的 images 顺序决定", () => {
    const images = [png("a.png"), png("b.png"), png("c.png")];
    expect(dispatchClipboardPaste(content({ kind: "images", images }), context())).toEqual({ kind: "importImages", at: AT });
  });

  it("只读画板：拒绝，不导入", () => {
    expect(dispatchClipboardPaste(content({ kind: "images", images: [png()] }), context({ readOnly: true }))).toEqual({ kind: "refuse", reason: "readOnly" });
  });
});

describe("读不出东西时给明确提示，不静默丢弃", () => {
  it("剪贴板为空：提示没有可粘的内容", () => {
    expect(dispatchClipboardPaste(content(), context())).toEqual({ kind: "notice", notice: "empty" });
  });

  it("剪贴板里是文件（只有名字没有内容）：提示改为拖入", () => {
    const snapshot = content({ kind: "unsupported", reason: "files" });
    expect(dispatchClipboardPaste(snapshot, context())).toEqual({ kind: "refuse", reason: "filesNotReadable" });
  });

  it("剪贴板里是不支持的格式（HEIC、TIFF 等）：提示内容不受支持", () => {
    expect(dispatchClipboardPaste(content({ kind: "unsupported", reason: "format" }), context())).toEqual({ kind: "notice", notice: "unsupported" });
  });

  it("单张图超过上限：沿用超限提示", () => {
    expect(dispatchClipboardPaste(content({ kind: "unsupported", reason: "tooLarge" }), context())).toEqual({ kind: "notice", notice: "tooLarge" });
  });

  it("超限优先于 busy：不可变小的图不能报成「稍后重试」（A3）", () => {
    expect(dispatchClipboardPaste(content({ kind: "busy", reason: "tooLarge" }), context())).toEqual({ kind: "notice", notice: "tooLarge" });
  });

  it("剪贴板被别的程序占用：给可重试的失败提示", () => {
    expect(dispatchClipboardPaste(content({ kind: "busy", reason: "busy" }), context())).toEqual({ kind: "notice", notice: "busy" });
  });

  it("读取途中剪贴板变了：同样是可重试的失败提示", () => {
    expect(dispatchClipboardPaste(content({ kind: "busy", reason: "changed" }), context())).toEqual({ kind: "notice", notice: "busy" });
  });

  it("读取本身失败：也算可重试，不把内部错误原文丢给用户", () => {
    expect(dispatchClipboardPaste(content({ kind: "busy", reason: "failed" }), context())).toEqual({ kind: "notice", notice: "busy" });
  });
});

describe("放行的粘贴", () => {
  it("普通文本：放行给浏览器 / 输入框，不提示也不吞", () => {
    expect(dispatchClipboardPaste(content({ kind: "text", text: "一段普通文字" }), context())).toEqual({ kind: "pass" });
  });

  it("输入框里粘文本：交给输入框自己", () => {
    expect(dispatchClipboardPaste(content({ kind: "text", text: "填进输入框" }), context({ textFocus: true }))).toEqual({ kind: "pass" });
  });

  it("模态开着：不作用于背后的画板，也不提示", () => {
    expect(dispatchClipboardPaste(content({ kind: "empty" }), context({ modal: true }))).toEqual({ kind: "pass" });
    expect(dispatchClipboardPaste(content({ kind: "busy", reason: "busy" }), context({ modal: true }))).toEqual({ kind: "pass" });
  });

  it("没有画板：放行", () => {
    expect(dispatchClipboardPaste(content({ kind: "images", images: [png()] }), context({ board: false }))).toEqual({ kind: "pass" });
  });
});
