// @vitest-environment jsdom
// 画布这层零碎接线的行为：拖线起点选择器、右键菜单条目与只读过滤、删除键开关、连线着色、
// 连线合法判定、边悬浮、另存为、选图加参考图、菜单 / 动作条的点击分派。
import { describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "@xyflow/react";
import { newBoard, type Board, type BoardEdge, type BoardNode, type ResultNode, type TaskNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import { menuItems, type MenuFacts, type MenuItem } from "../core/contextMenu";
import type { HoverInfo } from "../core/hoverInfo";
import { SAVE_TEXT } from "./boardText";
import {
  blockNativeContextMenu,
  connectionAllowed,
  connectionLineStyle,
  deleteKeyCodeFor,
  dragFromOf,
  edgeHoverMove,
  hoveredActionBarOf,
  menuEntriesOf,
  menuViewFor,
  openEdgeMenu,
  openNodeContextMenu,
  openPaneContextMenu,
  openSelectionContextMenu,
  pickActionBarAction,
  pickMenuAction,
  pickReferencesOf,
  saveNodeAsOf,
  toConnection,
  type CommandTable,
} from "./canvasFrame";
import type { CanvasMenuState } from "./useCanvasOverlaysState";

// ---- 画板夹具 ----

const prompt = (id: string): BoardNode => ({ id, type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text: "" });
const reference = (id: string): BoardNode => ({ id, type: "reference", pos: [0, 0], size: [100, 100], extra: {}, path: "x.png", sha256: "0".repeat(64), display_name: "x.png" });
const result = (id: string): ResultNode => ({
  id,
  type: "result",
  pos: [0, 0],
  size: [100, 100],
  extra: {},
  task_id: `t-${id}`,
  file: "result.png",
  path: `y/${id}/result.png`,
  layer_count: 0,
  record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "" },
});
const task = (id: string): TaskNode => ({
  id,
  type: "task",
  pos: [0, 0],
  size: [100, 100],
  extra: {},
  model: "qwen-image-3.0-pro",
  size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
  image_ports: 0,
  layer_decomposition: false,
  transparent_background: false,
  last_submitted: null,
});
const edgeOf = (from: string, fromPort: string, to: string, toPort: string): BoardEdge => ({
  from: [from, fromPort],
  to: [to, toPort],
  source_layer: null,
  region: null,
  system: false,
  extra: {},
});
const boardOf = (nodes: BoardNode[], edges: BoardEdge[] = []): Board => ({ ...newBoard("画板"), nodes, edges });

function factsOf(board: Board) {
  return (selected: ReadonlySet<string>): MenuFacts => ({
    board,
    table: BUILTIN_TABLE,
    selected,
    locked: new Set(),
    expanded: new Set(),
    undoLabel: null,
    redoLabel: null,
  });
}

const paneMenu: CanvasMenuState = { target: { kind: "pane" }, client: { x: 10, y: 20 }, at: { x: 1, y: 2 } };

/** 输入控件：右键时保留原生菜单。 */
const input = document.createElement("input");

describe("拖线起点选择器", () => {
  it("没在拖线时为 null", () => {
    expect(dragFromOf({ inProgress: false } as ConnectionState)).toBeNull();
  });

  it("拖线中取起点节点 / 端口 / 方向，缺 handle id 记空串", () => {
    expect(dragFromOf({ inProgress: true, fromHandle: { nodeId: "n1", id: "out", type: "source" } } as unknown as ConnectionState)).toEqual({
      nodeId: "n1",
      handleId: "out",
      type: "source",
    });
    expect(dragFromOf({ inProgress: true, fromHandle: { nodeId: "n1", id: null, type: "target" } } as unknown as ConnectionState)).toEqual({
      nodeId: "n1",
      handleId: "",
      type: "target",
    });
  });
});

describe("右键菜单", () => {
  it("画布内屏蔽原生菜单，输入控件上保留", () => {
    const preventDefault = vi.fn();
    blockNativeContextMenu({ target: document.createElement("div"), preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    preventDefault.mockClear();
    blockNativeContextMenu({ target: input, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("可编辑画板原样放行条目，归档画板只留查看类", () => {
    const items: MenuItem[] = [
      { action: "preview", label: "放大预览", disabledReason: null },
      { action: "delete", label: "删除", disabledReason: null },
      { action: "saveAs", label: "另存为…", disabledReason: null },
    ];
    expect(menuViewFor(false)(items)).toBe(items);
    expect(menuViewFor(true)(items).map((i) => i.action)).toEqual(["preview", "saveAs"]);
  });

  it("没开菜单时没有条目", () => {
    expect(menuEntriesOf(null, factsOf(boardOf([])), new Set(), menuViewFor(false))).toEqual([]);
  });

  it("空白处菜单按当前选区给条目", () => {
    const board = boardOf([prompt("p")]);
    const entries = menuEntriesOf(paneMenu, factsOf(board), new Set(["p"]), menuViewFor(false));
    expect(entries.map((i) => i.label)).toContain("新建提示词");
  });

  it("右键未选中节点换成它单选，落在选区内沿用选区", () => {
    const board = boardOf([reference("r"), result("x")]);
    const factsOfSpy = vi.fn(factsOf(board));
    const onResult: CanvasMenuState = { target: { kind: "node", nodeId: "x" }, client: { x: 0, y: 0 }, at: { x: 0, y: 0 } };
    menuEntriesOf(onResult, factsOfSpy, new Set(["r"]), menuViewFor(false));
    expect(factsOfSpy).toHaveBeenLastCalledWith(new Set(["x"]));

    menuEntriesOf(onResult, factsOfSpy, new Set(["r", "x"]), menuViewFor(false));
    expect(factsOfSpy).toHaveBeenLastCalledWith(new Set(["r", "x"]));
  });

  it("连线目标的菜单按当前选区给条目（菜单自己按 system 过滤）", () => {
    const board = boardOf([prompt("p"), task("t")], [edgeOf("p", "out", "t", "positive")]);
    const factsOfSpy = vi.fn(factsOf(board));
    const onEdge: CanvasMenuState = { target: { kind: "edge", edge: board.edges[0] }, client: { x: 0, y: 0 }, at: { x: 0, y: 0 } };
    const entries = menuEntriesOf(onEdge, factsOfSpy, new Set(), menuViewFor(false));
    expect(factsOfSpy).toHaveBeenLastCalledWith(new Set());
    expect(entries.map((i) => i.action)).toEqual(["disconnect"]);
  });
});

describe("React Flow 的开关与着色", () => {
  it("删除键：弹窗开着或归档画板时关掉，否则用画布配置里的键", () => {
    expect(deleteKeyCodeFor(true, false)).toBeNull();
    expect(deleteKeyCodeFor(false, true)).toBeNull();
    expect(deleteKeyCodeFor(false, false)).toEqual(["Delete", "Backspace"]);
  });

  it("拖线中按起点端口着色，没拖线不着色", () => {
    const board = boardOf([prompt("p")]);
    expect(connectionLineStyle(board, null)).toBeUndefined();
    const fromPrompt = { from: { nodeId: "p", handleId: "out", type: "source" as const }, ports: new Set<string>() };
    expect(connectionLineStyle(board, fromPrompt)).toEqual({ stroke: "var(--port-positive)" });
    const fromTaskTarget = { from: { nodeId: "t", handleId: "negative", type: "target" as const }, ports: new Set<string>() };
    expect(connectionLineStyle(board, fromTaskTarget)).toEqual({ stroke: "var(--port-negative)" });
  });

  it("端点缺失的 handle 记空串", () => {
    expect(toConnection({ source: "a", target: "b" })).toEqual({ source: "a", sourceHandle: "", target: "b", targetHandle: "" });
    expect(toConnection({ source: "a", sourceHandle: "out", target: "b", targetHandle: "positive" })).toEqual({
      source: "a",
      sourceHandle: "out",
      target: "b",
      targetHandle: "positive",
    });
  });
});

describe("连线合法判定", () => {
  const board = boardOf([prompt("p"), task("t")]);

  it("提示词出端口接任务正向端口连得上", () => {
    expect(connectionAllowed(board, BUILTIN_TABLE, new Set(), { source: "p", sourceHandle: "out", target: "t", targetHandle: "positive" })).toBe(true);
  });

  it("画板规则不允许的端口连不上", () => {
    expect(connectionAllowed(board, BUILTIN_TABLE, new Set(), { source: "p", sourceHandle: "out", target: "t", targetHandle: "image:0" })).toBe(false);
  });

  it("锁定的任务不接受连线", () => {
    expect(connectionAllowed(board, BUILTIN_TABLE, new Set(["t"]), { source: "p", sourceHandle: "out", target: "t", targetHandle: "positive" })).toBe(false);
  });
});

describe("边悬浮", () => {
  const hover = { move: vi.fn() };
  const info = { kind: "edge" } as unknown as HoverInfo;

  it("没有按键按下时把这条线的悬浮信息交给悬浮层", () => {
    hover.move.mockClear();
    edgeHoverMove({ buttons: 0, clientX: 5, clientY: 6 }, { id: "e1", data: { hover: info } }, hover);
    expect(hover.move).toHaveBeenCalledWith("edge:e1", info, 5, 6);
  });

  it("拖拽中或没带数据时不弹", () => {
    hover.move.mockClear();
    edgeHoverMove({ buttons: 1, clientX: 5, clientY: 6 }, { id: "e1", data: { hover: info } }, hover);
    edgeHoverMove({ buttons: 0, clientX: 5, clientY: 6 }, { id: "e1" }, hover);
    expect(hover.move).not.toHaveBeenCalled();
  });
});

describe("另存为", () => {
  it("参考图与结果节点都按绝对路径下载并提示", async () => {
    const save = vi.fn(async () => undefined);
    const toast = vi.fn();
    const board = boardOf([reference("r"), result("x")]);
    await saveNodeAsOf("r", { board, userRoot: "/~", toast, save });
    await saveNodeAsOf("x", { board, userRoot: "/~", toast, save });
    expect(save).toHaveBeenNthCalledWith(1, "/~/x.png");
    expect(save).toHaveBeenNthCalledWith(2, "/~/y/x/result.png");
    expect(toast).toHaveBeenCalledWith(SAVE_TEXT.started);
  });

  it("其它类型与不存在的节点什么都不做", async () => {
    const save = vi.fn(async () => undefined);
    const board = boardOf([prompt("p")]);
    await saveNodeAsOf("p", { board, userRoot: "/~", toast: vi.fn(), save });
    await saveNodeAsOf("gone", { board, userRoot: "/~", toast: vi.fn(), save });
    expect(save).not.toHaveBeenCalled();
  });

  it("下载失败时提示另存失败", async () => {
    const save = vi.fn(async () => {
      throw new Error("磁盘满了");
    });
    const toast = vi.fn();
    await saveNodeAsOf("r", { board: boardOf([reference("r")]), userRoot: "/~", toast, save });
    expect(toast).toHaveBeenCalledWith(SAVE_TEXT.failed("磁盘满了"));
  });
});

describe("选图加参考图", () => {
  const at = { x: 3, y: 4 };
  const centerPosition = () => ({ x: 9, y: 9 });

  it("没选文件就什么都不做", async () => {
    const importFiles = vi.fn(async () => undefined);
    await pickReferencesOf({ pickLocalImages: async () => [], importFiles, centerPosition });
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("没有落点时用视口中央，没有 attachTo 时可选多张", async () => {
    const importFiles = vi.fn(async () => undefined);
    const pickLocalImages = vi.fn(async () => [new File(["a"], "a.png")]);
    await pickReferencesOf({ pickLocalImages, importFiles, centerPosition });
    // 原实现是 `transfer.pickLocalImages(!attachTo)`：没有 attachTo 时可多选。
    expect(pickLocalImages).toHaveBeenCalledWith(true);
    expect(importFiles).toHaveBeenCalledWith([expect.any(File)], { x: 9, y: 9 }, undefined);
  });

  it("给了落点与 attachTo：只选一张并接到任务的原处", async () => {
    const importFiles = vi.fn(async () => undefined);
    const pickLocalImages = vi.fn(async () => [new File(["a"], "a.png")]);
    await pickReferencesOf({ pickLocalImages, importFiles, centerPosition }, at, "t1");
    expect(pickLocalImages).toHaveBeenCalledWith(false);
    expect(importFiles).toHaveBeenCalledWith([expect.any(File)], at, { taskId: "t1", place: "asIs" });
  });
});

describe("菜单 / 动作条的点击分派", () => {
  const command = vi.fn();
  const commands = { delete: command } as unknown as CommandTable;

  it("菜单关着（或动作条没有悬浮节点）时不执行", () => {
    command.mockClear();
    pickMenuAction("delete", null, commands);
    pickActionBarAction("delete", null, commands);
    expect(command).not.toHaveBeenCalled();
  });

  it("菜单点选按它记下的目标与落点执行", () => {
    command.mockClear();
    pickMenuAction("delete", paneMenu, commands);
    expect(command).toHaveBeenCalledWith({ kind: "pane" }, { x: 1, y: 2 });
  });

  it("动作条点选的目标是悬浮的那个节点", () => {
    command.mockClear();
    pickActionBarAction("delete", "n1", commands);
    expect(command).toHaveBeenCalledWith({ kind: "node", nodeId: "n1" });
  });

  it("画布不管的动作（表里没有）不出错", () => {
    command.mockClear();
    pickMenuAction("exportPack", paneMenu, commands);
    pickActionBarAction("exportPack", "n1", commands);
    expect(command).not.toHaveBeenCalled();
  });
});

describe("右键入口", () => {
  const openMenu = vi.fn();
  const event = (target: EventTarget | null) => ({ clientX: 1, clientY: 2, preventDefault: vi.fn(), target });

  it("空白右键交给菜单", () => {
    openMenu.mockClear();
    openPaneContextMenu(openMenu, event(document.createElement("div")));
    expect(openMenu).toHaveBeenCalledWith(expect.anything(), { kind: "pane" });
  });

  it("节点右键在输入控件上不弹菜单", () => {
    openMenu.mockClear();
    openNodeContextMenu(openMenu, event(input), "n1");
    expect(openMenu).not.toHaveBeenCalled();
    openNodeContextMenu(openMenu, event(document.createElement("div")), "n1");
    expect(openMenu).toHaveBeenCalledWith(expect.anything(), { kind: "node", nodeId: "n1" });
  });

  it("多选右键取第一个节点", () => {
    openMenu.mockClear();
    openSelectionContextMenu(openMenu, event(null), []);
    expect(openMenu).not.toHaveBeenCalled();
    openSelectionContextMenu(openMenu, event(null), [{ id: "a" }, { id: "b" }]);
    expect(openMenu).toHaveBeenCalledWith(expect.anything(), { kind: "node", nodeId: "a" });
  });

  it("连线右键按 React Flow 的连线 id 找回画板连线", () => {
    const board = boardOf([prompt("p"), task("t")], [edgeOf("p", "out", "t", "positive")]);
    openMenu.mockClear();
    openEdgeMenu(openMenu, board, event(null), "p:out->t:positive");
    expect(openMenu).toHaveBeenCalledWith(expect.anything(), { kind: "edge", edge: board.edges[0] });
    openMenu.mockClear();
    openEdgeMenu(openMenu, board, event(null), "没有这条线");
    expect(openMenu).not.toHaveBeenCalled();
  });
});

describe("悬浮动作条的显示条件", () => {
  const show = vi.fn();

  it("只有参考图与结果节点悬浮时显示", () => {
    show.mockClear();
    hoveredActionBarOf(show, { id: "r", type: "reference" });
    hoveredActionBarOf(show, { id: "x", type: "result" });
    expect(show.mock.calls).toEqual([["r"], ["x"]]);
  });

  it("提示词 / 任务节点不显示", () => {
    show.mockClear();
    hoveredActionBarOf(show, { id: "p", type: "prompt" });
    hoveredActionBarOf(show, { id: "t", type: "task" });
    hoveredActionBarOf(show, { id: "u" });
    expect(show).not.toHaveBeenCalled();
  });
});

describe("菜单条目与 core 同源", () => {
  it("动作条 / 菜单条目都来自 core/contextMenu 的同一份判定", () => {
    const board = boardOf([reference("r")]);
    const facts = factsOf(board)(new Set(["r"]));
    expect(menuEntriesOf(paneMenu, factsOf(board), new Set(["r"]), menuViewFor(false))).toEqual(menuItems({ kind: "pane" }, facts));
  });
});
