// @vitest-environment jsdom
// 画布浮层状态的接线：右键菜单（换选区、窗口坐标与画布坐标）、预览弹窗的 nonce、
// 「弹窗 / 菜单开着」的标记，以及视口开始移动时收菜单并清掉提示词聚焦请求。
// 用探针组件调用 hook，把返回值渲染成文本，再派发动作断言渲染结果与回调。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuTarget } from "../core/contextMenu";
import { useCanvasOverlaysState, type CanvasMenuState, type CanvasOverlaysState, type CanvasOverlaysStateInput, type CanvasPreviewState } from "./useCanvasOverlaysState";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- 渲染脚手架 ----

let container: HTMLDivElement;
let root: Root;
/** 探针拿到的最新一版 hook 返回值。 */
let state: CanvasOverlaysState;
let input: CanvasOverlaysStateInput;
let selectedRef: { current: ReadonlySet<string> };
let setSelectedNodes: (next: ReadonlySet<string>) => void;
let clearPromptFocus: () => void;
let screenToFlowPosition: (client: { x: number; y: number }) => { x: number; y: number };

const menuText = (menu: CanvasMenuState | null): string => (menu ? `${menu.target.kind} ${menu.client.x},${menu.client.y} ${menu.at.x},${menu.at.y}` : "none");
const previewText = (preview: CanvasPreviewState | null): string => (preview ? `${preview.req.title}#${preview.nonce}` : "none");

/** 把 hook 的返回值渲染成文本，重渲染后从 DOM 断言。 */
function Probe() {
  state = useCanvasOverlaysState(input);
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "menu" }, menuText(state.menu)),
    createElement("span", { "data-testid": "preview" }, previewText(state.preview)),
    createElement("span", { "data-testid": "dialog" }, String(state.dialogOpen)),
  );
}

async function show(): Promise<void> {
  await act(async () => root.render(createElement(Probe)));
}

const text = (testId: string): string => container.querySelector(`[data-testid="${testId}"]`)!.textContent!;

/** 右键事件的替身：只用 clientX / clientY / preventDefault。 */
function menuEvent(clientX = 30, clientY = 40): { clientX: number; clientY: number; preventDefault: () => void } {
  return { clientX, clientY, preventDefault: vi.fn<() => void>() };
}

const nodeTarget = (nodeId: string): MenuTarget => ({ kind: "node", nodeId });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  selectedRef = { current: new Set<string>() };
  setSelectedNodes = vi.fn<(next: ReadonlySet<string>) => void>();
  clearPromptFocus = vi.fn<() => void>();
  screenToFlowPosition = vi.fn<(client: { x: number; y: number }) => { x: number; y: number }>((client) => ({ x: client.x * 2, y: client.y * 3 }));
  input = { flow: { screenToFlowPosition }, selectedRef, setSelectedNodes, clearPromptFocus };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useCanvasOverlaysState", () => {
  it("初始什么都没开：菜单 / 预览为 null，弹窗标记为 false", async () => {
    await show();
    expect(text("menu")).toBe("none");
    expect(text("preview")).toBe("none");
    expect(text("dialog")).toBe("false");
    expect(state.dialogOpenRef.current).toBe(false);
  });

  it("右键落在未选中的节点上：先换选区，再记下窗口坐标与画布坐标", async () => {
    selectedRef.current = new Set(["p1"]);
    await show();
    const event = menuEvent(30, 40);
    await act(async () => state.openMenu(event, nodeTarget("r1")));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(setSelectedNodes).toHaveBeenCalledWith(new Set(["r1"]));
    expect(screenToFlowPosition).toHaveBeenCalledWith({ x: 30, y: 40 });
    // client = 窗口坐标，at = 同一点的画布坐标（新建节点落点）。
    expect(text("menu")).toBe("node 30,40 60,120");
    expect(text("dialog")).toBe("true");
    expect(state.dialogOpenRef.current).toBe(true);
    expect(state.menu).toMatchObject({ target: { kind: "node", nodeId: "r1" }, client: { x: 30, y: 40 }, at: { x: 60, y: 120 } });
  });

  it("右键落在已选中的节点上：保持原选区，菜单照开", async () => {
    const selected = new Set(["p1", "r1"]);
    selectedRef.current = selected;
    await show();
    await act(async () => state.openMenu(menuEvent(), nodeTarget("r1")));
    expect(setSelectedNodes).not.toHaveBeenCalled();
    expect(text("menu")).toBe("node 30,40 60,120");
  });

  it("右键落在画布空白上：不动选区", async () => {
    selectedRef.current = new Set(["p1"]);
    await show();
    await act(async () => state.openMenu(menuEvent(5, 6), { kind: "pane" }));
    expect(setSelectedNodes).not.toHaveBeenCalled();
    expect(text("menu")).toBe("pane 5,6 10,18");
  });

  it("关菜单后弹窗标记跟着回落", async () => {
    await show();
    await act(async () => state.openMenu(menuEvent(), { kind: "pane" }));
    await act(async () => state.closeMenu());
    expect(text("menu")).toBe("none");
    expect(text("dialog")).toBe("false");
    expect(state.dialogOpenRef.current).toBe(false);
  });

  it("每次打开预览弹窗 nonce 递增（作 key 重挂弹窗），关闭后清空", async () => {
    await show();
    await act(async () => state.openPreview({ title: "a.png", absPath: "/~/.data/a.png" }));
    expect(text("preview")).toBe("a.png#1");
    expect(text("dialog")).toBe("true");
    await act(async () => state.openPreview({ title: "b.png", absPath: "/~/.data/b.png" }));
    expect(text("preview")).toBe("b.png#2");
    await act(async () => state.closePreview());
    expect(text("preview")).toBe("none");
    expect(text("dialog")).toBe("false");
  });

  it("预览弹窗与菜单任一开着都算弹窗开着", async () => {
    await show();
    await act(async () => state.openPreview({ title: "a.png", absPath: "/~/.data/a.png" }));
    await act(async () => state.openMenu(menuEvent(), { kind: "pane" }));
    await act(async () => state.closePreview());
    expect(text("dialog")).toBe("true");
    expect(text("menu")).toBe("pane 30,40 60,120");
  });

  it("视口开始移动：收起菜单并清掉提示词聚焦请求", async () => {
    await show();
    await act(async () => state.openMenu(menuEvent(), { kind: "pane" }));
    await act(async () => state.onMoveStart());
    expect(clearPromptFocus).toHaveBeenCalledTimes(1);
    expect(text("menu")).toBe("none");
    expect(text("dialog")).toBe("false");
  });
});
