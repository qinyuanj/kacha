// @vitest-environment jsdom
// 画板快捷键的挂载点：window 上的 keydown 接到撤销 / 重做 / 复制；复制会写应用内剪贴板与系统剪贴板标记（#96）。
import { act, createElement } from "react";
import { ShellProvider } from "./shell";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { newBoard, type Board, type BoardNode } from "../core/board";
import { nodeMarker } from "../core/pageInput";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { PASTE_TEXT } from "./boardText";
import { readClipboard, writeClipboard } from "./canvasKeyboard";
import { useBoardKeyboard } from "./useBoardKeyboard";

// 系统剪贴板写入由壳端口替身记录：默认成功，个别用例让它失败。
// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Options = Parameters<typeof useBoardKeyboard>[0];

const prompt = (id: string): BoardNode => ({ id, type: "prompt", pos: [0, 0], size: [240, 120], text: id, extra: {} });

let container: HTMLDivElement;
let canvasEl: HTMLDivElement;
let root: Root | null;
let opts: Options;
let onUndo: Mock;
let onRedo: Mock;
let toast: Mock;
let board: Board;
let port: FakePort;

function Probe(): null {
  useBoardKeyboard(opts);
  return null;
}

async function show(): Promise<void> {
  await act(async () => root?.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
}

/** 等端口 copyText 的 catch 走完（写入失败那条提示是异步给的）。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 像用户按键一样派发 keydown（默认落在 window 上，与挂载点一致）。 */
function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(async () => {
  port = createFakePort();
  container = document.createElement("div");
  document.body.append(container);
  canvasEl = document.createElement("div");
  document.body.append(canvasEl);
  root = createRoot(container);
  onUndo = vi.fn();
  onRedo = vi.fn();
  toast = vi.fn();
  board = { ...newBoard("画板"), nodes: [prompt("p1"), prompt("p2")] };
  writeClipboard(null);
  opts = {
    wrapper: { current: canvasEl },
    boardRef: { current: board },
    selectedRef: { current: new Set(["p1"]) },
    dialogOpen: { current: false },
    onUndo,
    onRedo,
    toast,
    port,
  };
  await show();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  canvasEl.remove();
});

describe("撤销 / 重做", () => {
  it("Ctrl+Z 撤销，Ctrl+Shift+Z 与 Ctrl+Y 重做，并吞掉原生撤销", () => {
    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(press({ key: "z", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "y", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onRedo).toHaveBeenCalledTimes(2);
    // Cmd 与 Ctrl 等效。
    press({ key: "z", metaKey: true });
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it("不带 Ctrl / ⌘ 或带 Alt 的组合不归画板管", () => {
    expect(press({ key: "z" }).defaultPrevented).toBe(false);
    expect(press({ key: "z", ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("焦点在输入区：连原生撤销也让给它", () => {
    const input = document.createElement("input");
    document.body.append(input);
    try {
      expect(press({ key: "z", ctrlKey: true }, input).defaultPrevented).toBe(false);
    } finally {
      input.remove();
    }
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("画布根还没挂上（wrapper 为 null）时不响应", async () => {
    opts = { ...opts, wrapper: { current: null } };
    await show();
    press({ key: "z", ctrlKey: true });
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("大写按键照旧（键盘的大写锁定不影响快捷键）", () => {
    expect(press({ key: "Z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("弹窗开着时不复制", async () => {
    opts.dialogOpen.current = true;
    await show();
    const event = press({ key: "c", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(readClipboard()).toBeNull();
    expect(port.calls.copyText).toEqual([]);
  });

  it("带 Shift 的 C 与 Ctrl+Shift+V 都不处理", () => {
    expect(press({ key: "c", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "v", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(readClipboard()).toBeNull();
    expect(port.calls.copyText).toEqual([]);
  });

  it("画布根存在但已脱离文档时不响应，重新接入后恢复", () => {
    canvasEl.remove();
    expect(canvasEl.isConnected).toBe(false);
    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onUndo).not.toHaveBeenCalled();

    document.body.append(canvasEl);
    expect(canvasEl.isConnected).toBe(true);
    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("弹窗开着：吞掉原生撤销，但不作用于背后的画板", () => {
    opts.dialogOpen.current = true;
    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "z", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });

  it("带 Shift 的 Y 与其它 Ctrl 组合放行", () => {
    expect(press({ key: "y", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onRedo).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
  });
});

describe("复制", () => {
  it("Ctrl+C 复制选中节点：写应用内剪贴板与系统剪贴板标记，并拦掉原生复制", async () => {
    const event = press({ key: "c", ctrlKey: true });
    expect(readClipboard()?.nodes.map((n) => n.id)).toEqual(["p1"]);
    // 先拦原生复制，再把标记写进系统剪贴板：默认复制动作会把标记冲掉。
    expect(event.defaultPrevented).toBe(true);
    expect(port.calls.copyText).toEqual([nodeMarker(1)]);
    await settle();
    expect(toast).not.toHaveBeenCalled();
  });

  it("选区为空时 Ctrl+C 不动剪贴板，也不拦原生复制", () => {
    opts.selectedRef.current = new Set();
    const event = press({ key: "c", ctrlKey: true });
    expect(readClipboard()).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(port.calls.copyText).toEqual([]);
  });

  it("选区里没有可复制的节点（结果节点 / 已不在画板上）：写空快照，不拦原生复制也不写标记", () => {
    opts.selectedRef.current = new Set(["gone"]);
    const event = press({ key: "c", ctrlKey: true });
    expect(readClipboard()).toEqual({ nodes: [], edges: [] });
    expect(event.defaultPrevented).toBe(false);
    expect(port.calls.copyText).toEqual([]);
  });

  it("标记写不进系统剪贴板：提示给替代动作，剪贴板本身照旧", async () => {
    port.media.copyText = async () => {
      throw new Error("浏览器拒绝了复制操作");
    };
    const event = press({ key: "c", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(readClipboard()?.nodes.map((n) => n.id)).toEqual(["p1"]);
    await settle();
    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.markerUnwritable);
  });

  it("Ctrl+V 不归 keydown 管：什么都不做（粘贴由页面级 paste 接管）", () => {
    const event = press({ key: "v", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(readClipboard()).toBeNull();
  });
});

describe("复制图片（#130）", () => {
  const reference = (id: string, path: string): BoardNode => ({ id, type: "reference", pos: [0, 0], size: [200, 200], extra: {}, path, sha256: "a".repeat(64), display_name: "cat.png" });

  /** 选区恰好是一张参考图：Ctrl+C 走图片那条路。 */
  async function selectImage(path = "参考/cat.png"): Promise<void> {
    board = { ...newBoard("画板"), nodes: [reference("r1", path), prompt("p1")] };
    opts = { ...opts, boardRef: { current: board }, selectedRef: { current: new Set(["r1"]) } };
    await show();
  }

  it("单选一张参考图：写进系统剪贴板的是这张图，不写节点标记，也不动节点剪贴板", async () => {
    await selectImage();
    const event = press({ key: "c", ctrlKey: true });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    // 路径按数据根拼成绝对路径，格式提示跟着扩展名走。
    expect(port.calls.copyImage).toEqual([{ path: "/~/参考/cat.png", format: "png" }]);
    expect(port.calls.copyText).toEqual([]);
    expect(readClipboard()).toBeNull();
    // 复制图片不新增节点、不构成撤销步、不写画板。
    expect(board.nodes).toHaveLength(2);
    expect(onUndo).not.toHaveBeenCalled();
    expect(port.calls.write).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  // 选区分派（多选含图片、提示词节点、已不在画板上的 id 都走节点复制）由 core/pageInput 的
  // copyTarget 拥有；这里只留「单选参考图走图片」这一条本 hook 独有的执行路径。

  it.each([
    { name: "HEIC", file: "参考/cat.heic", detail: undefined },
    { name: "TIFF", file: "参考/cat.tiff", detail: "tiff" },
  ])("格式不受支持（$name）：明确失败并指向该节点的「另存为…」", async ({ file, detail }) => {
    port.media.copyImage = async () => ({ ok: false, reason: "unsupported", ...(detail ? { detail } : {}) });
    await selectImage(file);
    press({ key: "c", ctrlKey: true });
    await settle();
    expect(toast).toHaveBeenCalledTimes(1);
    const message = toast.mock.calls[0][0] as string;
    expect(message).toContain("复制图片失败");
    expect(message).toContain("另存为");
    // Go 认出容器名时把格式说清楚（TIFF），认不出时不编一个名字。
    if (detail) expect(message).toContain("TIFF");
  });

  it("剪贴板被占用：说成可重试，并指向「另存为…」，不报成功", async () => {
    port.media.copyImage = async () => ({ ok: false, reason: "busy" });
    await selectImage();
    press({ key: "c", ctrlKey: true });
    await settle();
    const message = toast.mock.calls[0][0] as string;
    expect(message).toContain("复制图片失败");
    expect(message).toContain("重试");
    expect(message).toContain("另存为");
  });

  it("端口抛异常：收成一句失败提示，不静默", async () => {
    port.media.copyImage = async () => {
      throw new Error("桥没实现");
    };
    await selectImage();
    press({ key: "c", ctrlKey: true });
    await settle();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("复制图片失败");
  });

  it("复制节点后粘贴是节点、复制图片后粘贴是图片：两边各写各的，不互相误判", async () => {
    // 先复制图片：系统剪贴板里只有图片，没有标记。
    await selectImage();
    press({ key: "c", ctrlKey: true });
    await settle();
    expect(port.calls.copyText).toEqual([]);
    // 再复制节点：系统剪贴板里是标记，没有图片。
    opts.selectedRef.current = new Set(["p1"]);
    await show();
    press({ key: "c", ctrlKey: true });
    await settle();
    expect(port.calls.copyImage).toHaveLength(1);
    expect(port.calls.copyText).toEqual([nodeMarker(1)]);
  });
});

describe("卸载", () => {
  it("卸载后 window 上不再留监听", async () => {
    await act(async () => root?.unmount());
    root = null;
    press({ key: "z", ctrlKey: true });
    press({ key: "c", ctrlKey: true });
    expect(onUndo).not.toHaveBeenCalled();
    expect(readClipboard()).toBeNull();
  });
});
