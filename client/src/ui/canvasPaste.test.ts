// @vitest-environment jsdom
// 页面级粘贴接管（#96）：节点标记粘节点、图片落成参考图、文本与读不到的文件放行或提示；
// 粘贴落点跟最后一次指针位置，没进过画布就取视口中央。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PASTE_OFFSET, type Clip } from "../core/iterate";
import { nodeMarker } from "../core/pageInput";
import { PNG_1X1_BASE64 } from "../core/testing/png";
import { ARCHIVE_TEXT, PASTE_TEXT, pasteImageFailureText } from "./boardText";
import { readClipboard, writeClipboard } from "./canvasKeyboard";
import { useCanvasPaste } from "./canvasPaste";

// readClipboard 包一层替身：默认照旧读真实剪贴板，个别用例让它两次读到的值不同（覆盖「分派判完就空」的防御分支）。
vi.mock("./canvasKeyboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canvasKeyboard")>();
  return { ...actual, readClipboard: vi.fn(() => actual.readClipboard()) };
});

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Options = Parameters<typeof useCanvasPaste>[0];

const clipOf = (id: string): Clip => ({ nodes: [{ id, type: "prompt", pos: [100, 200], size: [240, 120], text: id, extra: {} }], edges: [] });
/** 只带粘贴逻辑要读的三样的文件替身：名字、MIME、字节数。 */
const fileOf = (name: string, type: string, size = 1024): File => ({ name, type, size }) as unknown as File;
const image = (name = "shot.png") => fileOf(name, "image/png");
const opaque = (name = "报表.pdf") => fileOf(name, "application/pdf");
/** kind === "file" 的图片条目替身：粘贴逻辑只经 getAsFile() 取真实字节，不看条目自己的 MIME 声明。 */
const fileItem = (file: File | null, type = file?.type ?? "image/png") => ({ kind: "file", type, getAsFile: () => file });
/** 文本条目替身：kind 不是 file，粘贴逻辑不理它。 */
const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };
/** 图片 data URL。 */
const pngUrl = (b64 = PNG_1X1_BASE64): string => `data:image/png;base64,${b64}`;

let container: HTMLDivElement;
let canvasEl: HTMLDivElement;
let root: Root | null;
let opts: Options;
let apply: Mock;
let toast: Mock;
let importPastedImages: Mock;
let screenToFlowPosition: Mock;
let centerPosition: Mock;

function Probe(): null {
  useCanvasPaste(opts);
  return null;
}

async function show(): Promise<void> {
  await act(async () => root?.render(createElement(Probe)));
}

/** 合成剪贴板的形状：真浏览器里 files 与 items 常常同时有内容，这里可以只给一边。 */
interface Clipboard {
  files?: File[];
  items?: unknown[];
  text?: string | null;
  html?: string | null;
  uri?: string | null;
}

/** 剪贴板事件替身：jsdom 的 Event 上补一个 clipboardData（files / items / getData 三样够用）。 */
function pasteEvent(clipboard: Clipboard): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: clipboard.files ?? [],
      items: clipboard.items ?? [],
      getData: (type: string) => {
        if (type === "text/plain") return clipboard.text ?? "";
        if (type === "text/html") return clipboard.html ?? "";
        if (type === "text/uri-list") return clipboard.uri ?? "";
        return "";
      },
    },
  });
  return event;
}

/**
 * 合成一次粘贴并等它处理完：去重要读字节比较内容（同一张图经两条途径暴露时字节必然相同），
 * 那是异步的，所以断言落图之前要等一拍。
 */
async function paste(clipboard: Clipboard): Promise<Event> {
  const event = pasteEvent(clipboard);
  await act(async () => {
    window.dispatchEvent(event);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return event;
}

/** 指针最后一次在画布内的位置。 */
function pointerMove(at: { x: number; y: number }): void {
  canvasEl.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
}

/** 在输入框里造一个焦点：粘文本时焦点决定分派。 */
function focusedInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  return input;
}

/** 收掉输入框：先让焦点离开，免得下一个用例还以为焦点在输入区。 */
function dropInput(input: HTMLInputElement): void {
  input.blur();
  input.remove();
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  root = createRoot(container);
  apply = vi.fn();
  toast = vi.fn();
  importPastedImages = vi.fn();
  // 画布坐标 = 窗口坐标的一半，断言落点确实经 screenToFlowPosition 换算后再取整。
  screenToFlowPosition = vi.fn((client: { x: number; y: number }) => ({ x: client.x / 2, y: client.y / 2 }));
  centerPosition = vi.fn(() => ({ x: 500.4, y: 400.6 }));
  writeClipboard(null);
  opts = {
    wrapper: { current: canvasEl },
    dialogOpen: { current: false },
    modalOpen: false,
    readOnly: false,
    screenToFlowPosition,
    centerPosition,
    apply: apply as Options["apply"],
    toast,
    importPastedImages: importPastedImages as Options["importPastedImages"],
  };
  await show();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  canvasEl.remove();
  writeClipboard(null);
});

describe("放行的粘贴", () => {
  it("剪贴板里什么都没有：放行给浏览器", async () => {
    expect((await paste({})).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("普通文本：放行（画布上的文字仍能自己粘）", async () => {
    expect((await paste({ text: "一段普通文字" })).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("合成事件没带剪贴板内容 / 没带 files：当作什么都没有，放行", async () => {
    const bare = new Event("paste", { bubbles: true, cancelable: true });
    window.dispatchEvent(bare);
    expect(bare.defaultPrevented).toBe(false);

    const noFiles = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(noFiles, "clipboardData", { value: { getData: () => "" } });
    window.dispatchEvent(noFiles);
    expect(noFiles.defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("焦点在输入框里粘文本：交给输入框自己", async () => {
    const input = focusedInput();
    expect((await paste({ text: "填进输入框" })).defaultPrevented).toBe(false);
    dropInput(input);
  });

  it("模态开着（其它对话框 / 预览弹窗）时不作用于背后的画板", async () => {
    opts.dialogOpen.current = true;
    expect((await paste({ files: [image()] })).defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();

    opts = { ...opts, modalOpen: true };
    await show();
    expect((await paste({ files: [image()] })).defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});

describe("粘贴图片", () => {
  it("落点跟最后一次指针位置（画布坐标取整），吞掉默认行为", async () => {
    pointerMove({ x: 101, y: 51 });
    const event = await paste({ files: [image("shot.png")] });
    expect(event.defaultPrevented).toBe(true);
    // 101/2 = 50.5 → 51；51/2 = 25.5 → 26。
    expect(importPastedImages).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })], { x: 51, y: 26 });
    expect(centerPosition).not.toHaveBeenCalled();
  });

  it("指针从没进过画布：落在视口中央（同样取整）", async () => {
    await paste({ files: [image()] });
    expect(centerPosition).toHaveBeenCalled();
    expect(importPastedImages).toHaveBeenCalledWith([expect.anything()], { x: 500, y: 401 });
  });

  it("只读画板：只提示，不上传不落盘", async () => {
    opts = { ...opts, readOnly: true };
    await show();
    const event = await paste({ files: [image()] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("读不到内容的文件（资源管理器里复制的）：提示改为拖入", async () => {
    const event = await paste({ files: [opaque()] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("没有内容的图片（size 为 0）按读不到的文件算", async () => {
    await paste({ files: [fileOf("empty.png", "image/png", 0)] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("文本与图片一起粘：图片才落盘", async () => {
    await paste({ files: [image(), opaque()], text: "顺带复制到的文字" });
    expect(importPastedImages).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })], expect.anything());
  });
});

describe("剪贴板图片归一化", () => {
  /** 交给落图链路的那批文件（按调用顺序）。 */
  const imported = (): File[] => (importPastedImages.mock.calls[0]?.[0] ?? []) as File[];
  const importedNames = (): string[] => imported().map((f) => f.name);

  it("只有图片条目、没有文件列表：照样落图（系统截图 / 网页「复制图片」可能只在 items 里给图）", async () => {
    const shot = image("shot.png");
    const event = await paste({ items: [fileItem(shot)] });
    expect(event.defaultPrevented).toBe(true);
    expect(imported()).toEqual([shot]);
  });

  it("同一张图同时经文件列表和图片条目暴露：只导入一份", async () => {
    // 真浏览器里两条途径给的是不同 File 实例，但字节相同。
    await paste({ files: [image("shot.png")], items: [fileItem(image("shot.png"))] });
    expect(importPastedImages).toHaveBeenCalledTimes(1);
    expect(importedNames()).toEqual(["shot.png"]);
  });

  it("两张同名同类型同大小但内容不同的图：算两张，不误并成一张", async () => {
    // 内容摘要不同：只靠名字、类型、大小分不出来。
    const bytes = (n: number): File =>
      ({ name: "shot.png", type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([n, n, n]).buffer }) as unknown as File;
    await paste({ files: [bytes(1)], items: [fileItem(bytes(2))] });
    expect(imported()).toHaveLength(2);
  });

  it("多图保持事件里的顺序：文件列表按原序，只有条目暴露的接在后面", async () => {
    await paste({ files: [image("a.png"), image("b.png")], items: [fileItem(image("c.png"))] });
    expect(importedNames()).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("条目取不到文件：进现有的「请把文件拖进画板」反馈，不落图", async () => {
    const event = await paste({ items: [fileItem(null)] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("零字节的图片条目：同样按读不到内容算", async () => {
    await paste({ items: [fileItem(fileOf("empty.png", "image/png", 0))] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("条目声明是图片、取到的却不是图片文件：按不受支持处理，不凭 MIME 声明认成功", async () => {
    await paste({ items: [fileItem(opaque("报表.pdf"), "image/png")] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("非图片条目（文本等）不改变分派：放行", async () => {
    expect((await paste({ items: [textItem] })).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("图片条目 + 节点标记：标记优先，粘节点而不是落图", async () => {
    const clip = clipOf("p1");
    writeClipboard(clip);
    await paste({ text: nodeMarker(1), items: [fileItem(image())] });
    expect(apply).toHaveBeenCalledWith({ kind: "paste", clip });
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("输入框里粘只有图片条目的内容：仍落图", async () => {
    const input = focusedInput();
    await paste({ items: [fileItem(image())] });
    expect(importPastedImages).toHaveBeenCalled();
    dropInput(input);
  });

  it("只读画板 + 图片条目：只提示，不落盘", async () => {
    opts = { ...opts, readOnly: true };
    await show();
    expect((await paste({ items: [fileItem(image())] })).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});

describe("内嵌图片 data URL（#114）", () => {
  /** 交给落图链路的那批文件（按调用顺序）。 */
  const imported = (): File[] => (importPastedImages.mock.calls[0]?.[0] ?? []) as File[];

  it("文本里就是一段图片 data URL：解出真实字节落成参考图", async () => {
    const event = await paste({ text: pngUrl() });
    expect(event.defaultPrevented).toBe(true);
    expect(imported()).toHaveLength(1);
    expect(imported()[0].type).toBe("image/png");
    expect(imported()[0].size).toBeGreaterThan(0);
  });

  it("HTML 里 img 的 src 是 data URL：同样落成参考图", async () => {
    await paste({ html: `<img src="${pngUrl()}">` });
    expect(imported()).toHaveLength(1);
  });

  it("输入框里粘一串图片 data URL：仍是文本，交给输入框自己（不改成导图）", async () => {
    const input = focusedInput();
    const event = await paste({ text: pngUrl() });
    expect(event.defaultPrevented).toBe(false);
    expect(imported()).toHaveLength(0);
    dropInput(input);
  });

  it("data URL 解不开：提示原因，不落图", async () => {
    const event = await paste({ text: "data:image/png;base64,!!!!" });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(pasteImageFailureText({ invalid: 1, unsupported: 0, tooLarge: 0 }));
    expect(imported()).toHaveLength(0);
  });

  it("data URL 格式不受支持：提示原因，不落图", async () => {
    await paste({ text: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
    expect(toast).toHaveBeenCalledWith(pasteImageFailureText({ invalid: 0, unsupported: 1, tooLarge: 0 }));
    expect(imported()).toHaveLength(0);
  });

  it("同批里有一张解不开、另一张可读：可读的那张照旧落图", async () => {
    await paste({ text: `data:image/png;base64,!!!!\n${pngUrl()}` });
    expect(imported()).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith(pasteImageFailureText({ invalid: 1, unsupported: 0, tooLarge: 0 }));
  });

  it("网络图片地址：提示改用本机文件，不当成图片导入，也不去抓", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const event = await paste({ html: '<img src="https://example.com/a.png?token=secret">' });
    expect(event.defaultPrevented).toBe(true);
    expect(imported()).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.remoteImage);
    // 不泄漏来源地址与鉴权信息。
    expect(toast.mock.calls[0][0]).not.toContain("example.com");
    expect(toast.mock.calls[0][0]).not.toContain("secret");
    // 应用绝不主动去抓网络图片。
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("文本就是一张网络图片地址：提示先保存到本机，不导入", async () => {
    const event = await paste({ text: "https://example.com/a.png" });
    expect(event.defaultPrevented).toBe(true);
    expect(imported()).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.remoteImage);
  });

  it("HTML 里没有图片：明确提示改用文件，不静默", async () => {
    const event = await paste({ html: "<p>一段网页文字</p>" });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.noSupportedImage);
    expect(imported()).toHaveLength(0);
  });

  it("HTML 内容带着纯文本、却没有图片：仍是 HTML 类内容，明确提示而不是放行", async () => {
    const event = await paste({ html: "<p>一段网页文字</p>", text: "一段网页文字" });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.noSupportedImage);
    expect(imported()).toHaveLength(0);
  });

  it("URI 类内容里没有图片：明确提示改用文件", async () => {
    const event = await paste({ uri: "https://example.com/page" });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.remoteImage);
    expect(imported()).toHaveLength(0);
  });

  it("空剪贴板：照旧放行给浏览器，不提示", async () => {
    expect((await paste({})).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("普通纯文本：照旧放行，不被误拦", async () => {
    expect((await paste({ text: "一段普通文字" })).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("混合内容：可读图片照旧落图，不为非图片文件另建节点", async () => {
    await paste({ files: [image(), opaque()], text: "顺带复制到的文字" });
    expect(imported()).toHaveLength(1);
    expect(imported()[0].name).toBe("shot.png");
  });
});

describe("粘贴节点", () => {
  it("节点标记 + 应用内剪贴板有内容：粘节点，剪贴板逐次错开", async () => {
    const clip = clipOf("p1");
    writeClipboard(clip);
    await paste({ text: nodeMarker(1) });
    expect(apply).toHaveBeenCalledWith({ kind: "paste", clip });
    expect(readClipboard()?.nodes[0].pos).toEqual([100 + PASTE_OFFSET, 200 + PASTE_OFFSET]);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("节点标记还在但内存剪贴板空了：提示重新复制", async () => {
    writeClipboard(null);
    await paste({ text: nodeMarker(1) });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(apply).not.toHaveBeenCalled();
  });

  it("节点标记对应的应用内快照没有节点：同样按失效剪贴板拒绝", async () => {
    writeClipboard({ nodes: [], edges: [] });
    await paste({ text: nodeMarker(1) });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(apply).not.toHaveBeenCalled();
  });

  it("分派判为粘节点、读剪贴板时却空了：不崩也不落盘（防御分支，正常路径走不到）", async () => {
    const clip = clipOf("p1");
    writeClipboard(clip);
    vi.mocked(readClipboard).mockReturnValueOnce(clip).mockReturnValueOnce(null);
    await paste({ text: nodeMarker(1) });
    expect(apply).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("只读画板：粘节点也拒绝", async () => {
    opts = { ...opts, readOnly: true };
    await show();
    writeClipboard(clipOf("p1"));
    const event = await paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("卸载与挂载", () => {
  it("卸载后 window 上不再留粘贴监听", async () => {
    await act(async () => root?.unmount());
    root = null;
    const event = await paste({ files: [image()] });
    expect(event.defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("挂载时画布根还没有元素：照样能粘（落点取视口中央）", async () => {
    await act(async () => root?.unmount());
    root = createRoot(container);
    opts = { ...opts, wrapper: { current: null } };
    await show();
    await paste({ files: [image()] });
    expect(centerPosition).toHaveBeenCalled();
    expect(importPastedImages).toHaveBeenCalled();
  });
});
