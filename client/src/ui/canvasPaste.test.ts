// @vitest-environment jsdom
// 页面级粘贴接管（#96）：节点标记粘节点、图片落成参考图、文本与读不到的文件放行或提示；
// 粘贴落点跟最后一次指针位置，没进过画布就取视口中央。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PASTE_OFFSET, type Clip } from "../core/iterate";
import { nodeMarker } from "../core/pageInput";
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
/** kind === "file" 的图片条目替身：粘贴逻辑只经 getAsFile() 取真实字节，不看条目自己的 MIME 声明。 */
const fileItem = (file: File | null, type = file?.type ?? "image/png") => ({ kind: "file", type, getAsFile: () => file });
/** 文本条目替身：kind 不是 file，粘贴逻辑不理它。 */
const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };

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
}

/** 剪贴板事件替身：jsdom 的 Event 上补一个 clipboardData（files / items / getData 三样够用）。 */
function pasteEvent(clipboard: Clipboard): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: clipboard.files ?? [],
      items: clipboard.items ?? [],
      getData: (type: string) => (type === "text/plain" ? (clipboard.text ?? "") : ""),
    },
  });
  return event;
}

function paste(clipboard: Clipboard): Event {
  const event = pasteEvent(clipboard);
  window.dispatchEvent(event);
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
  it("剪贴板里什么都没有：放行给浏览器", () => {
    expect(paste({}).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("普通文本：放行（画布上的文字仍能自己粘）", () => {
    expect(paste({ text: "一段普通文字" }).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("合成事件没带剪贴板内容 / 没带 files：当作什么都没有，放行", () => {
    const bare = new Event("paste", { bubbles: true, cancelable: true });
    window.dispatchEvent(bare);
    expect(bare.defaultPrevented).toBe(false);

    const noFiles = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(noFiles, "clipboardData", { value: { getData: () => "" } });
    window.dispatchEvent(noFiles);
    expect(noFiles.defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("焦点在输入框里粘文本：交给输入框自己", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(paste({ text: "填进输入框" }).defaultPrevented).toBe(false);
    input.remove();
  });

  it("模态开着（其它对话框 / 预览弹窗）时不作用于背后的画板", async () => {
    opts.dialogOpen.current = true;
    expect(paste({ files: [image()] }).defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();

    opts = { ...opts, modalOpen: true };
    await show();
    expect(paste({ files: [image()] }).defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});

describe("粘贴图片", () => {
  it("落点跟最后一次指针位置（画布坐标取整），吞掉默认行为", () => {
    pointerMove({ x: 101, y: 51 });
    const event = paste({ files: [image("shot.png")] });
    expect(event.defaultPrevented).toBe(true);
    // 101/2 = 50.5 → 51；51/2 = 25.5 → 26。
    expect(importPastedImages).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })], { x: 51, y: 26 });
    expect(centerPosition).not.toHaveBeenCalled();
  });

  it("指针从没进过画布：落在视口中央（同样取整）", () => {
    paste({ files: [image()] });
    expect(centerPosition).toHaveBeenCalled();
    expect(importPastedImages).toHaveBeenCalledWith([expect.anything()], { x: 500, y: 401 });
  });

  it("只读画板：只提示，不上传不落盘", async () => {
    opts = { ...opts, readOnly: true };
    await show();
    const event = paste({ files: [image()] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("读不到内容的文件（资源管理器里复制的）：提示改为拖入", () => {
    const event = paste({ files: [opaque()] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("没有内容的图片（size 为 0）按读不到的文件算", () => {
    paste({ files: [fileOf("empty.png", "image/png", 0)] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("文本与图片一起粘：图片才落盘", () => {
    paste({ files: [image(), opaque()], text: "顺带复制到的文字" });
    expect(importPastedImages).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })], expect.anything());
  });
});

describe("剪贴板图片归一化", () => {
  /** 交给落图链路的那批文件（按调用顺序）。 */
  const imported = (): File[] => (importPastedImages.mock.calls[0]?.[0] ?? []) as File[];
  const importedNames = (): string[] => imported().map((f) => f.name);

  it("只有图片条目、没有文件列表：照样落图（系统截图 / 网页「复制图片」可能只在 items 里给图）", () => {
    const shot = image("shot.png");
    const event = paste({ items: [fileItem(shot)] });
    expect(event.defaultPrevented).toBe(true);
    expect(imported()).toEqual([shot]);
  });

  it("同一张图同时经文件列表和图片条目暴露：只导入一份", () => {
    // 真浏览器里两条途径给的是不同 File 实例，但名字、类型、大小一致。
    paste({ files: [image("shot.png")], items: [fileItem(image("shot.png"))] });
    expect(importPastedImages).toHaveBeenCalledTimes(1);
    expect(importedNames()).toEqual(["shot.png"]);
  });

  it("多图保持事件里的顺序：文件列表按原序，只有条目暴露的接在后面", () => {
    paste({ files: [image("a.png"), image("b.png")], items: [fileItem(image("a.png")), fileItem(image("c.png"))] });
    expect(importedNames()).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("条目取不到文件：进现有的「请把文件拖进画板」反馈，不落图", () => {
    const event = paste({ items: [fileItem(null)] });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("零字节的图片条目：同样按读不到内容算", () => {
    paste({ items: [fileItem(fileOf("empty.png", "image/png", 0))] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("条目声明是图片、取到的却不是图片文件：按不受支持处理，不凭 MIME 声明认成功", () => {
    paste({ items: [fileItem(opaque("报表.pdf"), "image/png")] });
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("非图片条目（文本等）不改变分派：放行", () => {
    expect(paste({ items: [textItem] }).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("图片条目 + 节点标记：标记优先，粘节点而不是落图", () => {
    const clip = clipOf("p1");
    writeClipboard(clip);
    paste({ text: nodeMarker(1), items: [fileItem(image())] });
    expect(apply).toHaveBeenCalledWith({ kind: "paste", clip });
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("输入框里粘只有图片条目的内容：仍落图", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    paste({ items: [fileItem(image())] });
    expect(importPastedImages).toHaveBeenCalled();
    input.remove();
  });

  it("只读画板 + 图片条目：只提示，不落盘", async () => {
    opts = { ...opts, readOnly: true };
    await show();
    expect(paste({ items: [fileItem(image())] }).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});

describe("粘贴节点", () => {
  it("节点标记 + 应用内剪贴板有内容：粘节点，剪贴板逐次错开", () => {
    const clip = clipOf("p1");
    writeClipboard(clip);

    const event = paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledWith({ kind: "paste", clip });
    expect(readClipboard()?.nodes[0].pos).toEqual([100 + PASTE_OFFSET, 200 + PASTE_OFFSET]);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("节点标记还在但内存剪贴板空了：提示重新复制", () => {
    const event = paste({ text: nodeMarker(2) });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(apply).not.toHaveBeenCalled();
  });

  it("节点标记对应的应用内快照没有节点：同样按失效剪贴板拒绝", () => {
    // null 与空节点数组都不能让 hasNodeClip 成立；这个分支不能靠后面的防御性 return 才拒绝。
    vi.mocked(readClipboard).mockReturnValueOnce({ nodes: [], edges: [] });
    const event = paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
    expect(apply).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("分派判为粘节点、读剪贴板时却空了：不崩也不落盘（防御分支，正常路径走不到）", () => {
    // 同一帧内没有 await，正常不会变；这里让两次读数不同，锁住防御分支的行为。
    vi.mocked(readClipboard).mockReturnValueOnce(clipOf("p1")).mockReturnValueOnce(null);
    const event = paste({ text: nodeMarker(1) });
    expect(event.defaultPrevented).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("只读画板：粘节点也拒绝", async () => {
    writeClipboard(clipOf("p1"));
    opts = { ...opts, readOnly: true };
    await show();
    expect(paste({ text: nodeMarker(1) }).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("卸载与挂载", () => {
  it("卸载后 window 上不再留粘贴监听", async () => {
    await act(async () => root?.unmount());
    root = null;
    expect(paste({ files: [image()] }).defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("挂载时画布根还没有元素：照样能粘（落点取视口中央）", async () => {
    opts = { ...opts, wrapper: { current: null } };
    await show();
    paste({ files: [image()] });
    expect(centerPosition).toHaveBeenCalled();
    expect(importPastedImages).toHaveBeenCalled();
  });
});
