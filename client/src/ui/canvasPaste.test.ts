// @vitest-environment jsdom
// 页面级粘贴接管（#96）：节点标记粘节点、图片落成参考图、文本与读不到的文件放行或提示；
// 粘贴落点跟最后一次指针位置，没进过画布就取视口中央。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PASTE_OFFSET, type Clip } from "../core/iterate";
import type { ClipboardContent } from "../core/clipboardDispatch";
import { isNodeMarker, nodeMarker } from "../core/pageInput";
import { ARCHIVE_TEXT, PASTE_TEXT } from "./boardText";
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

let nativeSnapshot: ClipboardContent | null = null;
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

/** 剪贴板事件替身：jsdom 的 Event 上补一个 clipboardData。 */
function pasteEvent(clipboard: { files?: File[]; text?: string | null }): Event {
  const files = clipboard.files ?? [];
  const images = files.filter(file => file.type.startsWith("image/") && file.size > 0);
  const text = clipboard.text ?? null;
  nativeSnapshot = { kind: isNodeMarker(text) ? "mark" : images.length ? "images" : files.length ? "unsupported" : text ? "text" : "empty", text, images, reason: files.length && !images.length ? "files" : null, readFailureCount: files.length - images.length };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: clipboard.files ?? [],
      getData: (type: string) => (type === "text/plain" ? (clipboard.text ?? "") : ""),
    },
  });
  return event;
}

async function paste(clipboard: { files?: File[]; text?: string | null }): Promise<Event> {
  const event = pasteEvent(clipboard);
  await act(async () => { window.dispatchEvent(event); await Promise.resolve(); });
  return event;
}

/** 指针最后一次在画布内的位置。 */
function pointerMove(at: { x: number; y: number }): void {
  canvasEl.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
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
    isEditableTarget: (target) => target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null,
    // 原生快照通过测试端口提供，事件只触发一次粘贴。
    readClipboard: async () => nativeSnapshot,
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

describe("放行的粘贴", async () => {
  it("剪贴板为空时明确提示", async () => {
    await paste({});
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.empty);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("普通文本：吞掉默认粘贴，但不落图不写画板也不提示", async () => {
    // 原生读取是异步的，生产在读取之前一律吞掉默认行为；画布上没有可粘文本的地方，所以没有损失。
    expect((await paste({ text: "一段普通文字" })).defaultPrevented).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("事件没有内容仍由原生端口处理", async () => {
    const bare = new Event("paste", { bubbles: true, cancelable: true });
    window.dispatchEvent(bare);
    expect(bare.defaultPrevented).toBe(true);

    const noFiles = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(noFiles, "clipboardData", { value: { getData: () => "" } });
    window.dispatchEvent(noFiles);
    expect(noFiles.defaultPrevented).toBe(true);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("焦点在输入框里粘文本：交给输入框自己", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect((await paste({ text: "填进输入框" })).defaultPrevented).toBe(false);
    input.remove();
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

describe("粘贴图片", async () => {
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

describe("粘贴节点", async () => {
  it("节点标记 + 应用内剪贴板有内容：粘节点，剪贴板逐次错开", async () => {
    const clip = clipOf("p1");
    writeClipboard(clip);

    const event = await paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledWith({ kind: "paste", clip });
    expect(readClipboard()?.nodes[0].pos).toEqual([100 + PASTE_OFFSET, 200 + PASTE_OFFSET]);
    expect(importPastedImages).not.toHaveBeenCalled();
    // 再粘一次：错开量是叠加的（剪贴板本身被推进一格，原快照不动）。
    await paste({ text: nodeMarker(1) });
    expect(apply).toHaveBeenLastCalledWith({
      kind: "paste",
      clip: { ...clip, nodes: [{ ...clip.nodes[0], pos: [100 + PASTE_OFFSET, 200 + PASTE_OFFSET] }] },
    });
    expect(readClipboard()?.nodes[0].pos).toEqual([100 + 2 * PASTE_OFFSET, 200 + 2 * PASTE_OFFSET]);
  });

  it("节点标记还在但内存剪贴板空了：提示重新复制", async () => {
    const event = await paste({ text: nodeMarker(2) });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(apply).not.toHaveBeenCalled();
  });

  it("节点标记对应的应用内快照没有节点：同样按失效剪贴板拒绝", async () => {
    // null 与空节点数组都不能让 hasNodeClip 成立；这个分支不能靠后面的防御性 return 才拒绝。
    vi.mocked(readClipboard).mockReturnValueOnce({ nodes: [], edges: [] });
    const event = await paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(apply).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("只读画板：粘节点也拒绝", async () => {
    writeClipboard(clipOf("p1"));
    opts = { ...opts, readOnly: true };
    await show();
    expect((await paste({ text: nodeMarker(1) })).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("原生快照的其余结局（壳端口读到什么就照什么分派）", async () => {
  /** 换一份原生快照：读剪贴板的端口替身按它回值。 */
  async function withSnapshot(snapshot: ClipboardContent | null | (() => Promise<ClipboardContent | null>)): Promise<void> {
    opts = { ...opts, readClipboard: typeof snapshot === "function" ? snapshot : async () => snapshot };
    await show();
  }

  it("节点标记 + 应用内剪贴板为空：标记优先，提示重新复制而不是落图", async () => {
    await withSnapshot({ kind: "mark", text: nodeMarker(1), images: [image()], reason: null, readFailureCount: 0 });
    const event = await paste({ text: nodeMarker(1), files: [image()] });
    expect(event.defaultPrevented).toBe(true);
    expect(importPastedImages).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
  });

  it.each([
    { name: "内容格式不受支持", snapshot: { kind: "unsupported", reason: "format" }, text: PASTE_TEXT.unsupported },
    { name: "剪贴板被占用", snapshot: { kind: "busy", reason: "busy" }, text: PASTE_TEXT.busy },
    { name: "单张超过上限", snapshot: { kind: "unsupported", reason: "tooLarge" }, text: PASTE_TEXT.tooLarge },
    { name: "剪贴板里只有文件", snapshot: { kind: "unsupported", reason: "files" }, text: PASTE_TEXT.filesNotReadable },
  ])("$name：明确提示，不落图", async ({ snapshot, text }) => {
    await withSnapshot({ kind: "empty", text: null, images: [], reason: null, readFailureCount: 0, ...snapshot } as ClipboardContent);
    await paste({});
    expect(importPastedImages).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(text);
  });

  it("端口读剪贴板抛错：当作读不到，提示不可用", async () => {
    await withSnapshot(() => Promise.reject(new Error("剪贴板不可用")));
    const event = await paste({});
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.unavailable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("读不到原生快照：提示不可用，不用事件里的图片", async () => {
    await withSnapshot(null);
    await paste({ files: [image()] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.unavailable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});

describe("卸载与挂载", async () => {
  it("卸载后 window 上不再留粘贴监听", async () => {
    await act(async () => root?.unmount());
    root = null;
    expect((await paste({ files: [image()] })).defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("挂载时画布根还没有元素：照样能粘（落点取视口中央）", async () => {
    opts = { ...opts, wrapper: { current: null } };
    await show();
    await paste({ files: [image()] });
    expect(centerPosition).toHaveBeenCalled();
    expect(importPastedImages).toHaveBeenCalled();
  });
});
