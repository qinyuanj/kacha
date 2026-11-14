// @vitest-environment jsdom
// 系统剪贴板粘贴经壳端口驱动（#129）：桌面壳读到快照后，分派与成功 / 部分成功 / 失败的传递。
// 端口是内存替身（shell/testing/fakePort），不起 MyGo runtime、不发请求。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardContent } from "../core/clipboardDispatch";
import { nodeMarker } from "../core/pageInput";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { PASTE_TEXT } from "./boardText";
import { useCanvasPaste } from "./canvasPaste";
import { ShellProvider, useShell } from "./shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const png = (name = "shot.png", size = 8): File => new File([new Uint8Array(size)], name, { type: "image/png" });
const snapshot = (over: Partial<ClipboardContent> = {}): ClipboardContent => ({ kind: "empty", text: null, images: [], reason: null, readFailureCount: 0, ...over });

let container: HTMLDivElement;
let root: Root | null;
let port: FakePort;
let importPastedImages: ReturnType<typeof vi.fn>;
let toast: (message: string) => void;
let apply: ReturnType<typeof vi.fn>;
let snapshotValue: ClipboardContent | null;

/** 挂在真端口上的探针：粘贴走 useCanvasPaste，壳端口来自 ShellProvider。 */
function Probe(): null {
  const shellPort = useShell();
  useCanvasPaste({
    wrapper: { current: null },
    dialogOpen: { current: false },
    modalOpen: false,
    readOnly: false,
    screenToFlowPosition: (client) => client,
    centerPosition: () => ({ x: 0, y: 0 }),
    apply: apply as never,
    toast,
    importPastedImages: importPastedImages as never,
    isEditableTarget: (target) => target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null,
    readClipboard: () => Promise.resolve(snapshotValue),
    nativeClipboard: shellPort.features.nativeClipboard ?? false,
  });
  return null;
}

async function show(): Promise<void> {
  await act(async () => root?.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
  await act(async () => {
    await Promise.resolve();
  });
}

/** 端口替身：features 只读，按需要造一份声明（或不声明）原生剪贴板能力的。 */
function nativePort(native: boolean): FakePort {
  const created = createFakePort();
  return { ...created, features: { ...created.features, ...(native ? { nativeClipboard: true } : {}) } };
}

/** 一次 Ctrl+V：桌面壳的路由（nativeClipboard）不看事件内容，只看端口读到的快照。 */
async function paste(text = ""): Promise<Event> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type: string) => (type === "text/plain" ? text : "") } });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  apply = vi.fn();
  toast = vi.fn<(message: string) => void>();
  importPastedImages = vi.fn();
  snapshotValue = snapshot();
  // 桌面壳的端口：features.nativeClipboard 为 true 时粘贴先读原生快照。
  port = nativePort(true);
  await show();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

describe("原生剪贴板：成功", () => {
  it("一张图：落成参考图节点，落点经端口读到的分派给出", async () => {
    const image = png();
    snapshotValue = snapshot({ kind: "images", images: [image] });
    expect((await paste()).defaultPrevented).toBe(true);
    expect(importPastedImages).toHaveBeenCalledWith([image], { x: 0, y: 0 });
    expect(toast).not.toHaveBeenCalled();
  });

  it("多图：一次粘贴把整批交给导入链路（顺序就是快照里的顺序）", async () => {
    const images = [png("a.png"), png("b.png", 9)];
    snapshotValue = snapshot({ kind: "images", images });
    await paste();
    expect(importPastedImages).toHaveBeenCalledWith(images, expect.anything());
  });

  it("节点标记：粘节点，不再读图片", async () => {
    snapshotValue = snapshot({ kind: "mark", text: nodeMarker(1), images: [png()] });
    await paste();
    // 应用内剪贴板是空的：标记优先，走的是「重新复制」而不是粘图。
    expect(importPastedImages).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.staleNodeClip);
  });
});

describe("原生剪贴板：普通文本仍放行", () => {
  it("普通文本：不提示、不写画板、不落图", async () => {
    snapshotValue = snapshot({ kind: "text", text: "一段普通文字" });
    // 画布上没有可粘文本的地方；原生读是异步的，所以默认行为已经先吞掉——丢不了任何东西。
    await paste("一段普通文字");
    expect(toast).not.toHaveBeenCalled();
    expect(importPastedImages).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("焦点在输入框里粘文本：交给输入框自己", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    snapshotValue = snapshot({ kind: "text", text: "填进输入框" });
    expect((await paste("填进输入框")).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    input.remove();
  });
});

describe("原生剪贴板：失败与空", () => {
  it("空剪贴板：明确提示，不静默", async () => {
    snapshotValue = snapshot({ kind: "empty" });
    await paste();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.empty);
    expect(importPastedImages).not.toHaveBeenCalled();
  });

  it("不受支持的格式：说清内容不受支持", async () => {
    snapshotValue = snapshot({ kind: "unsupported", reason: "format" });
    await paste();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.unsupported);
  });

  it("剪贴板被占用：可重试的提示", async () => {
    snapshotValue = snapshot({ kind: "busy", reason: "busy" });
    await paste();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.busy);
  });

  it("单张超限：沿用超限提示", async () => {
    snapshotValue = snapshot({ kind: "unsupported", reason: "tooLarge" });
    await paste();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.tooLarge);
  });

  it("剪贴板里是文件：提示改为拖入", async () => {
    snapshotValue = snapshot({ kind: "unsupported", reason: "files" });
    await paste();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.filesNotReadable);
  });

  it("端口读剪贴板抛错：当作读不到，不崩也不静默", async () => {
    snapshotValue = null;
    port.media.readClipboard = () => Promise.reject(new Error("剪贴板不可用"));
    await paste();
    // 退回 paste 事件（这里事件是空的）：什么都不做，与 Web 一致。
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});

describe("Web 的路不变", () => {
  it("nativeClipboard 为 false 时仍按 paste 事件分派，不吞普通文本", async () => {
    port = nativePort(false);
    await show();
    snapshotValue = snapshot({ kind: "images", images: [png()] });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: (type: string) => (type === "text/plain" ? "一段普通文字" : "") } });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(importPastedImages).not.toHaveBeenCalled();
  });
});
