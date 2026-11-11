// @vitest-environment jsdom
// useCanvasInteraction 的接线：keydown / wheel / pointerdown 落成 apply、选区变化与 React Flow 调用。
// @xyflow/react 用替身（真实 <ReactFlow> 需要画布量测），这里只验接线；判定本身在 canvasKeys / altDrag 的单测里。
import { act, createElement, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { Board, BoardNode } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { canvasFlowProps } from "./canvasFlowProps";
import { useCanvasInteraction, type Selection } from "./useCanvasInteraction";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// vi.mock 先于 import 执行，替身用 vi.hoisted 提前造好。
const flowStub = vi.hoisted(() => ({
  getViewport: vi.fn(() => ({ x: 10, y: 20, zoom: 1.5 })),
  setViewport: vi.fn(async () => true),
  fitView: vi.fn(async () => true),
  zoomTo: vi.fn(async () => true),
  zoomIn: vi.fn(async () => true),
  zoomOut: vi.fn(async () => true),
}));
const connectionState = vi.hoisted(() => ({ inProgress: false }));

vi.mock("@xyflow/react", () => ({
  SelectionMode: { Partial: "partial", Full: "full" },
  useReactFlow: () => flowStub,
  useStoreApi: () => ({ getState: () => ({ connection: connectionState }) }),
}));

type Ids = ReadonlySet<string>;
type Nav = ReturnType<typeof useCanvasInteraction>;

// ---- 画板与渲染脚手架 ----

const prompt = (id: string, pos: [number, number] = [0, 0]): BoardNode => ({ type: "prompt", id, pos, size: [100, 100], text: id, extra: {} });

const board = (nodes: BoardNode[]): Board => ({ format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges: [], extra: {} });

let container: HTMLDivElement;
let root: Root;
let nav: Nav;
/** 当前的节点 / 连线选区；setNodes / setEdges 同步回写，测试直接读。 */
let nodes: Ids;
let edges: Ids;
let applied: BoardChange[];
let applyResult: EditResult | null;
let boardRef: MutableRefObject<Board>;
let wrapperRef: RefObject<HTMLDivElement | null>;
let dialogOpen: MutableRefObject<boolean>;
let selection: Selection;
let canvas: HTMLDivElement;

const apply = (change: BoardChange): EditResult | null => {
  applied.push(change);
  return applyResult;
};

/** 探针组件：调 hook，把返回值挂到外面的 nav 上，并按 BoardCanvas 的方式接线（画布根元素 + 指针捕获）。 */
function Probe(props: { wireRef: boolean }) {
  nav = useCanvasInteraction({ wrapper: wrapperRef, boardRef, selection, dialogOpen, apply });
  return createElement("div", {
    className: "canvas",
    ref: (el: HTMLDivElement | null) => {
      if (props.wireRef) wrapperRef.current = el;
    },
    onPointerDownCapture: (e) => nav.onPointerDownCapture(e),
    onPointerUpCapture: () => nav.onPointerUpCapture(),
  });
}

/**
 * 渲染 hook。wireRef = false：wrapper 一直是 null（还没量到画布）。
 * 画布根元素由 React 渲染（root 会清空 container 的既有子节点），wrapper 的 ref 由 ref 回调回填。
 */
function mount(options: { nodes?: string[]; board?: Board; wireRef?: boolean } = {}): void {
  nodes = new Set(options.nodes ?? ["a"]);
  edges = new Set();
  applied = [];
  applyResult = null;
  boardRef = { current: options.board ?? board([prompt("a", [10, 20])]) };
  dialogOpen = { current: false };
  wrapperRef = { current: null };
  const setNodes: Dispatch<SetStateAction<Ids>> = (next) => {
    nodes = typeof next === "function" ? next(nodes) : next;
  };
  const setEdges: Dispatch<SetStateAction<Ids>> = (next) => {
    edges = typeof next === "function" ? next(edges) : next;
  };
  // 选区 ref 直接读外面的集合，读到 / 写到的都是当前选区。
  selection = {
    nodes: { get current() { return nodes; } },
    edges: { get current() { return edges; } },
    setNodes,
    setEdges,
  };
  act(() => root.render(createElement(Probe, { wireRef: options.wireRef !== false })));
  canvas = container.querySelector<HTMLDivElement>(".canvas")!;
}

function keydown(k: string, patch: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...patch });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  connectionState.inProgress = false;
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// ---- 固定配置 ----

describe("flowProps", () => {
  it("直接返回 canvasFlowProps（同一个对象）", () => {
    mount();
    expect(nav.flowProps).toBe(canvasFlowProps);
  });
});

// ---- 键盘 ----

describe("键盘", () => {
  it("方向键微移选中节点；Shift 10px", () => {
    mount();
    keydown("ArrowRight");
    keydown("ArrowDown", { shiftKey: true });
    expect(applied).toEqual([
      { kind: "nudge", ids: ["a"], delta: [1, 0] },
      { kind: "nudge", ids: ["a"], delta: [0, 10] },
    ]);
  });

  it("没有选中节点时方向键不写画板", () => {
    mount({ nodes: [] });
    keydown("ArrowRight");
    expect(applied).toEqual([]);
  });

  it("defaultPrevented 的方向键照样微移，其余键不处理（#97 页面级接管已吞掉方向键）", () => {
    mount();
    const prevented = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    prevented.preventDefault();
    act(() => {
      window.dispatchEvent(prevented);
    });
    expect(applied).toEqual([{ kind: "nudge", ids: ["a"], delta: [-1, 0] }]);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    escape.preventDefault();
    act(() => {
      window.dispatchEvent(escape);
    });
    expect([...nodes]).toEqual(["a"]);
  });

  it("Ctrl+0 / 1 / = / + / - 走 React Flow，动画用 ZOOM_DURATION_MS", () => {
    mount();
    keydown("0", { ctrlKey: true });
    keydown("1", { metaKey: true });
    keydown("=", { ctrlKey: true });
    keydown("+", { ctrlKey: true });
    keydown("-", { ctrlKey: true });
    expect(flowStub.fitView).toHaveBeenCalledWith({ duration: 200 });
    expect(flowStub.zoomTo).toHaveBeenCalledWith(1, { duration: 200 });
    expect(flowStub.zoomIn).toHaveBeenCalledTimes(2);
    expect(flowStub.zoomIn).toHaveBeenCalledWith({ duration: 200 });
    expect(flowStub.zoomOut).toHaveBeenCalledWith({ duration: 200 });
    expect(applied).toEqual([]);
  });

  it("Ctrl+J 原地复制选中节点（drag = null）", () => {
    mount({ nodes: ["a", "b"] });
    keydown("j", { ctrlKey: true });
    expect(applied).toEqual([{ kind: "duplicate", ids: ["a", "b"], drag: null }]);
  });

  it("视图 / 编辑类命令吞掉默认行为，表外组合什么都不做", () => {
    mount();
    expect(keydown("0", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(keydown("ArrowUp").defaultPrevented).toBe(true);
    expect(keydown("z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(flowStub.fitView).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(1);
  });

  it("Esc 清空节点与连线选区，且不改默认行为", () => {
    mount({ nodes: ["a", "b"] });
    edges = new Set(["e"]);
    const escape = keydown("Escape");
    expect(nodes.size).toBe(0);
    expect(edges.size).toBe(0);
    expect(escape.defaultPrevented).toBe(false);
  });

  it("连线拖动中的 Esc 不清选区", () => {
    mount({ nodes: ["a"] });
    connectionState.inProgress = true;
    keydown("Escape");
    expect([...nodes]).toEqual(["a"]);
  });

  it("焦点在可编辑控件里时不响应画布键位", () => {
    mount();
    const input = document.createElement("input");
    canvas.append(input);
    const onInput = (k: string, patch: Partial<KeyboardEventInit> = {}): void => {
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...patch }));
      });
    };
    onInput("ArrowRight");
    onInput("0", { ctrlKey: true });
    expect(applied).toEqual([]);
    expect(flowStub.fitView).not.toHaveBeenCalled();
  });

  it("弹窗开着时不响应画布键位", () => {
    mount();
    dialogOpen.current = true;
    keydown("ArrowRight");
    keydown("Escape");
    expect(applied).toEqual([]);
    expect([...nodes]).toEqual(["a"]);
  });

  it("wrapper 已卸载（不在文档里）时不响应画布键位", () => {
    mount();
    container.remove();
    expect(canvas.isConnected).toBe(false);
    keydown("ArrowRight");
    expect(applied).toEqual([]);
  });

  it("卸载后不再监听键盘", async () => {
    mount();
    await act(async () => root.unmount());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(applied).toEqual([]);
  });
});

// ---- 滚轮 ----

describe("触控板双指平移", () => {
  const wheel = (patch: Partial<WheelEventInit> = {}): WheelEvent => new WheelEvent("wheel", { deltaX: 0, deltaY: 2.5, deltaMode: 0, bubbles: true, cancelable: true, ...patch });

  it("带横向分量的滚轮平移视口并吞掉默认行为", () => {
    mount();
    const e = wheel({ deltaX: 4, deltaY: 0 });
    act(() => {
      canvas.dispatchEvent(e);
    });
    expect(flowStub.setViewport).toHaveBeenCalledWith({ x: 6, y: 20, zoom: 1.5 });
    expect(e.defaultPrevented).toBe(true);
  });

  it("子元素上不冒泡的双指滚动也在捕获阶段平移", () => {
    mount();
    const child = document.createElement("div");
    canvas.append(child);
    const e = wheel({ deltaX: 4, deltaY: 0, bubbles: false });
    act(() => {
      child.dispatchEvent(e);
    });
    expect(flowStub.setViewport).toHaveBeenCalledWith({ x: 6, y: 20, zoom: 1.5 });
    expect(e.defaultPrevented).toBe(true);
  });

  it("鼠标滚轮交给 React Flow 缩放，不平移", () => {
    mount();
    const e = wheel({ deltaY: 100 });
    act(() => {
      canvas.dispatchEvent(e);
    });
    expect(flowStub.setViewport).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it(".nowheel 区域内让给控件自己处理", () => {
    mount();
    const nowheel = document.createElement("div");
    nowheel.className = "nowheel";
    canvas.append(nowheel);
    act(() => {
      nowheel.dispatchEvent(wheel());
    });
    expect(flowStub.setViewport).not.toHaveBeenCalled();
  });

  it("画布上其它子元素里的双指滑动照样平移", () => {
    mount();
    const child = document.createElement("div");
    canvas.append(child);
    act(() => {
      child.dispatchEvent(wheel());
    });
    expect(flowStub.setViewport).toHaveBeenCalledTimes(1);
  });

  it("卸载后移除捕获阶段的滚轮监听", async () => {
    mount();
    await act(async () => root.unmount());
    const e = wheel({ deltaX: 4, deltaY: 0 });
    act(() => {
      canvas.dispatchEvent(e);
    });
    expect(flowStub.setViewport).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("wrapper 还不存在时不挂监听，也不崩", () => {
    mount({ wireRef: false });
    expect(wrapperRef.current).toBeNull();
    expect(flowStub.setViewport).not.toHaveBeenCalled();
  });
});

// ---- 指针：Shift + 框选 ----

describe("Shift 框选加选", () => {
  function pointer(type: string, target: Element, patch: Partial<PointerEventInit> = {}): void {
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...patch }));
    });
  }

  function pane(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "react-flow__pane";
    canvas.append(el);
    return el;
  }

  it("Shift + 在画布空白按下：框选对原选区的取消选中被忽略（加选）", () => {
    mount({ nodes: ["a"] });
    pointer("pointerdown", pane(), { shiftKey: true });
    act(() => nav.selectNodes([{ id: "a", selected: false }, { id: "b", selected: true }]));
    expect([...nodes].sort()).toEqual(["a", "b"]);
  });

  it("没有 Shift 时按普通框选处理：原选区被清掉", () => {
    mount({ nodes: ["a"] });
    pointer("pointerdown", pane());
    act(() => nav.selectNodes([{ id: "a", selected: false }]));
    expect([...nodes]).toEqual([]);
  });

  it("Shift 按在节点上不算框选加选（React Flow 会框选，原选区不保）", () => {
    mount({ nodes: ["a"] });
    const node = document.createElement("div");
    node.className = "react-flow__node";
    canvas.append(node);
    pointer("pointerdown", node, { shiftKey: true });
    act(() => nav.selectNodes([{ id: "a", selected: false }]));
    expect([...nodes]).toEqual([]);
  });

  it("松手后保留的选区失效", () => {
    mount({ nodes: ["a"] });
    const target = pane();
    pointer("pointerdown", target, { shiftKey: true });
    pointer("pointerup", target);
    act(() => nav.selectNodes([{ id: "a", selected: false }]));
    expect([...nodes]).toEqual([]);
  });

  it("连线选区同一套规则", () => {
    mount();
    edges = new Set(["e"]);
    pointer("pointerdown", pane(), { shiftKey: true });
    act(() => nav.selectEdges([{ id: "e", selected: false }]));
    expect([...edges]).toEqual(["e"]);
  });
});

// ---- Alt + 拖复制 ----

describe("Alt + 拖复制", () => {
  const dragged = (...ids: string[]): Node[] => ids.map((id) => ({ id }) as Node);

  it("开始：叠一份副本（drag 带 id 与副本数），返回复制出的节点数", () => {
    mount({ board: board([prompt("a", [10, 20])]) });
    applyResult = { board: board([prompt("a", [10, 20]), prompt("n1", [10, 20])]), step: { label: "复制 1" } };
    expect(nav.startDrag({ altKey: true }, dragged("a"), 3)).toBe(1);
    expect(applied).toEqual([{ kind: "duplicate", ids: ["a"], drag: { id: 3, copies: 1 } }]);
  });

  it("松手：对调原节点与副本，合并键沿用拖动编号", () => {
    mount({ board: board([prompt("a", [10, 20])]) });
    applyResult = { board: board([prompt("a", [10, 20]), prompt("n1", [10, 20])]), step: { label: "复制 1" } };
    nav.startDrag({ altKey: true }, dragged("a"), 3);
    nav.stopDrag(3);
    expect(applied[1]).toEqual({ kind: "settleDrag", drag: { id: 3, copies: 1 }, pairs: [["a", "n1"]], starts: [["a", [10, 20]]] });
  });

  it("不是 Alt：普通拖动，不写画板、返回 0", () => {
    mount();
    expect(nav.startDrag({ altKey: false }, dragged("a"), 1)).toBe(0);
    nav.stopDrag(1);
    expect(applied).toEqual([]);
  });

  it("没拖到可复制的节点（如只拖结果节点）：不写画板、返回 0", () => {
    mount();
    expect(nav.startDrag({ altKey: true }, dragged("nope"), 1)).toBe(0);
    expect(applied).toEqual([]);
  });

  it("apply 被拒（返回 null）：返回 0，松手不再对调", () => {
    mount();
    applyResult = null;
    expect(nav.startDrag({ altKey: true }, dragged("a"), 2)).toBe(0);
    nav.stopDrag(2);
    expect(applied).toEqual([{ kind: "duplicate", ids: ["a"], drag: { id: 2, copies: 1 } }]);
  });

  it("apply 没落账（step 为 null）：返回 0，松手不再对调", () => {
    mount();
    applyResult = { board: board([prompt("a", [10, 20]), prompt("n1", [10, 20])]), step: null };
    expect(nav.startDrag({ altKey: true }, dragged("a"), 4)).toBe(0);
    nav.stopDrag(4);
    expect(applied).toEqual([{ kind: "duplicate", ids: ["a"], drag: { id: 4, copies: 1 } }]);
  });

  it("没在复制时松手不写画板", () => {
    mount();
    nav.stopDrag(5);
    expect(applied).toEqual([]);
  });
});
