// @vitest-environment jsdom
// 画布拖放的挂载点：dragover 拦下浏览器默认接管、drop 在捕获阶段先接（#97），图片按落点导入成参考图节点。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { newBoard, type Board, type BoardNode } from "../core/board";
import { ipc, transfer } from "../shell/ipc";
import { ARCHIVE_TEXT, IMPORT_TEXT } from "./boardText";
import { knownImageInfo } from "./context";
import { imageImportPorts, useCanvasDrop } from "./useCanvasDrop";

// 本机图片的上传与元信息读取走壳层端口：这里换成替身，避免真的发请求。
vi.mock("../shell/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell/ipc")>();
  return {
    ...actual,
    ipc: { ...actual.ipc, inspectImage: vi.fn() },
    transfer: { ...actual.transfer, uploadReference: vi.fn() },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Options = Parameters<typeof useCanvasDrop>[0];

const imageInfo = { sha256: "sha-a", bytes: 10, width: 64, height: 48, format: "png", has_alpha: false };
const fileOf = (name: string, type: string): File => new File(["x"], name, { type });

const reference = (id: string): BoardNode => ({ id, type: "reference", pos: [0, 0], size: [240, 160], path: `refs/${id}.png`, sha256: `sha-${id}`, display_name: id, extra: {} });
const task = (id: string): BoardNode => ({
  id,
  type: "task",
  pos: [0, 0],
  size: [280, 240],
  model: "m",
  size_spec: { tier: "1k", ratio: "1:1", width: null, height: null, auto_ratio: null },
  image_ports: 0,
  layer_decomposition: false,
  transparent_background: false,
  last_submitted: null,
  extra: {},
});

let container: HTMLDivElement;
let canvasEl: HTMLDivElement;
let taskCard: HTMLDivElement;
let paneEl: HTMLDivElement;
let root: Root | null;
let opts: Options;
let apply: Mock;
let toast: Mock;
let screenToFlowPosition: Mock;
let elementAt: Mock;

function Probe(): null {
  useCanvasDrop(opts);
  return null;
}

async function show(): Promise<void> {
  await act(async () => root?.render(createElement(Probe)));
}

/** 等拖入后的上传 / 读元信息 / 落盘走完（真定时器，拍平微任务链）。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 拖放事件替身：jsdom 没有 DragEvent，用 MouseEvent 补上 dataTransfer。 */
function dragEvent(kind: "dragover" | "drop", dataTransfer: unknown, at = { x: 30, y: 40 }): MouseEvent {
  const event = new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

const fileDrag = (...files: File[]) => ({ types: ["Files"], files });

beforeEach(async () => {
  vi.mocked(transfer.uploadReference).mockReset();
  vi.mocked(ipc.inspectImage).mockReset();
  vi.mocked(transfer.uploadReference).mockImplementation(async (file: File) => ({ path: `导入参考图/${file.name}`, sha256: "sha-a" }));
  vi.mocked(ipc.inspectImage).mockImplementation(async () => imageInfo);

  container = document.createElement("div");
  document.body.append(container);
  canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  // 落点：任务卡片、画布空白各一个真元素，closest 由 canvasPoint 自己走。
  paneEl = document.createElement("div");
  paneEl.className = "react-flow";
  taskCard = document.createElement("div");
  taskCard.className = "react-flow__node";
  taskCard.dataset.id = "t1";
  paneEl.append(taskCard);
  document.body.append(paneEl);
  elementAt = vi.fn(() => null);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number, y: number) => elementAt(x, y) });

  root = createRoot(container);
  apply = vi.fn();
  toast = vi.fn();
  // 画布坐标 = 窗口坐标的两倍，断言落点确实经 screenToFlowPosition 换算。
  screenToFlowPosition = vi.fn((client: { x: number; y: number }) => ({ x: client.x * 2, y: client.y * 2 }));
  const board: Board = { ...newBoard("画板"), nodes: [task("t1"), reference("r1")] };
  opts = {
    wrapper: { current: canvasEl },
    boardRef: { current: board },
    screenToFlowPosition,
    apply: apply as Options["apply"],
    toast,
    userRoot: "/~",
    readOnly: false,
  };
  await show();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  canvasEl.remove();
  paneEl.remove();
});

describe("imageImportPorts", () => {
  it("三个方法分别转发到壳层上传、元信息读取与画布缓存（选图加参考图也走这一组）", async () => {
    const file = fileOf("a.png", "image/png");
    await expect(imageImportPorts.upload(file)).resolves.toEqual({ path: "导入参考图/a.png", sha256: "sha-a" });
    expect(transfer.uploadReference).toHaveBeenCalledWith(file);

    await expect(imageImportPorts.inspect("/~/导入参考图/a.png")).resolves.toEqual(imageInfo);
    expect(ipc.inspectImage).toHaveBeenCalledWith("/~/导入参考图/a.png");

    imageImportPorts.prime("/~/导入参考图/cached.png", imageInfo);
    expect(knownImageInfo("/~/导入参考图/cached.png")).toEqual(imageInfo);
  });
});

describe("dragover", () => {
  it("带文件的拖拽被拦下（浏览器别接管本次拖拽），纯文本拖拽放行", () => {
    expect(canvasEl.dispatchEvent(dragEvent("dragover", fileDrag()))).toBe(false);
    expect(canvasEl.dispatchEvent(dragEvent("dragover", { types: ["text/plain"], files: [] }))).toBe(true);
  });
});

describe("drop", () => {
  it("不带文件的 drop 一概不管", () => {
    const event = dragEvent("drop", fileDrag());
    expect(canvasEl.dispatchEvent(event)).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("只读画板：提示只读，不导入", async () => {
    opts = { ...opts, readOnly: true };
    await show();
    const event = dragEvent("drop", fileDrag(fileOf("a.png", "image/png")));
    canvasEl.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("拖的不是图片：提示只支持图片文件，不导入", () => {
    canvasEl.dispatchEvent(dragEvent("drop", fileDrag(fileOf("note.txt", "text/plain"))));
    expect(toast).toHaveBeenCalledWith(IMPORT_TEXT.imageOnly);
    expect(transfer.uploadReference).not.toHaveBeenCalled();
  });

  it("拖入图片：捕获阶段先接并阻断冒泡，按松手处落成参考图节点", async () => {
    const bubbled = vi.fn();
    canvasEl.addEventListener("drop", bubbled);
    const event = dragEvent("drop", fileDrag(fileOf("a.png", "image/png")), { x: 30, y: 40 });
    // 派发到画布内的子元素：捕获阶段的监听先跑，stopPropagation 让冒泡监听收不到。
    const inner = document.createElement("div");
    canvasEl.append(inner);
    inner.dispatchEvent(event);
    expect(bubbled).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    await settle();

    expect(transfer.uploadReference).toHaveBeenCalledTimes(1);
    expect(ipc.inspectImage).toHaveBeenCalledWith("/~/导入参考图/a.png");
    // 图片信息写进了画布缓存：随后渲染不用再读一次。
    expect(knownImageInfo("/~/导入参考图/a.png")).toEqual(imageInfo);
    expect(apply).toHaveBeenCalledWith({
      kind: "addReferences",
      images: [{ path: "导入参考图/a.png", sha256: "sha-a", display_name: "a.png", width: 64, height: 48 }],
      at: [60, 80],
      attach: null,
    });
    inner.remove();
    canvasEl.removeEventListener("drop", bubbled);
  });

  it("落在任务卡片上：挂到该任务左侧", async () => {
    elementAt.mockReturnValue(taskCard);
    canvasEl.dispatchEvent(dragEvent("drop", fileDrag(fileOf("a.png", "image/png"))));
    await settle();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ attach: { taskId: "t1", place: "left" } }));
  });

  it("落在画布空白：就地新建参考图节点", async () => {
    elementAt.mockReturnValue(paneEl);
    canvasEl.dispatchEvent(dragEvent("drop", fileDrag(fileOf("a.png", "image/png"))));
    await settle();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ attach: null }));
  });

  it("调用方每次渲染换新的坐标换算函数（箭头包装）：用最新那一版，监听不必重挂", async () => {
    const next = vi.fn(() => ({ x: 1, y: 2 }));
    opts = { ...opts, screenToFlowPosition: next };
    await show();
    canvasEl.dispatchEvent(dragEvent("drop", fileDrag(fileOf("a.png", "image/png"))));
    await settle();
    expect(next).toHaveBeenCalled();
    expect(screenToFlowPosition).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ at: [1, 2] }));
  });

  it("上传失败：提示原因，不落盘", async () => {
    vi.mocked(transfer.uploadReference).mockRejectedValue(new Error("服务端拒绝"));
    canvasEl.dispatchEvent(dragEvent("drop", fileDrag(fileOf("a.png", "image/png"))));
    await settle();
    expect(toast).toHaveBeenCalledWith(IMPORT_TEXT.failed("a.png", "服务端拒绝"));
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("卸载", () => {
  it("卸载后拖放不再被接管", async () => {
    await act(async () => root?.unmount());
    root = null;
    expect(canvasEl.dispatchEvent(dragEvent("dragover", fileDrag()))).toBe(true);
    expect(canvasEl.dispatchEvent(dragEvent("drop", fileDrag(fileOf("a.png", "image/png"))))).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("挂载时画布根还没有元素：什么都不挂，也不炸", async () => {
    opts = { ...opts, wrapper: { current: null } };
    await show();
    expect(canvasEl.dispatchEvent(dragEvent("dragover", fileDrag()))).toBe(true);
  });
});
