// 画布的 React Flow 事件：节点 / 连线变更、拖拽与缩放的合并编号、拖线松手的三种落点、
// 删除前的「先取消再删除」确认、视口变更与跳转居中。替身注入选区句柄与写入入口，落点命中用替身元素。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Edge, Node, NodeChange } from "@xyflow/react";
import type { Board, BoardEdge, BoardNode, ReferenceNode, ResultNode, TaskNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { BoardChange, EditResult } from "../core/edit";
import { LOCKED_HINT } from "../core/iterate";
import { browser } from "../shell/ipc";
import { DELETE_TASK_TEXT } from "./boardText";
import { flowBookkeeping, flowHandlers, type DropState, type FlowBookkeeping, type FlowHandlerDeps } from "./canvasFlowHandlers";

vi.mock("../shell/ipc", () => ({ browser: { ask: vi.fn() } }));

const SPEC = { tier: "1K", ratio: "1:1", width: null, height: null } as const;

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

function reference(id: string): ReferenceNode {
  return { id, type: "reference", pos: [0, 0], size: [200, 220], extra: {}, path: `refs/${id}.png`, sha256: "a".repeat(64), display_name: `${id}.png` };
}

function result(id: string): ResultNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [220, 300],
    extra: {},
    task_id: `task-${id}`,
    file: `${id}.png`,
    path: `results/${id}/${id}.png`,
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "", negative_prompt: "", size_spec: { ...SPEC }, submitted_at: "" },
  };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return { id, type: "task", pos: [100, 200], size: [280, 260], extra: {}, model: "qwen-image-3.0", size_spec: { ...SPEC }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...patch };
}

function edge(from: [string, string], to: [string, string], patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {}, ...patch };
}

/** 空画板：参考图 + 提示词节点 + 一个没有连线的图片任务 + 一个结果节点。 */
function emptyBoard(): Board {
  return board([reference("ref1"), { id: "p1", type: "prompt", pos: [0, 0], size: [240, 160], extra: {}, text: "" }, task("t1"), result("res1")]);
}

const xyNode = (id: string) => ({ id }) as Node;
const xyEdge = (id: string) => ({ id }) as Edge;

/** 画布根元素与它的视口矩形（新建类动作的缺省落点用）。 */
function wrapperOf(rect: { left: number; top: number; width: number; height: number } | null): { current: HTMLDivElement | null } {
  return { current: rect ? ({ getBoundingClientRect: () => rect } as unknown as HTMLDivElement) : null };
}

interface Harness {
  deps: FlowHandlerDeps;
  refs: FlowBookkeeping;
  apply: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  onCancelTask: ReturnType<typeof vi.fn>;
  selectNodes: ReturnType<typeof vi.fn>;
  selectEdges: ReturnType<typeof vi.fn>;
  startDrag: ReturnType<typeof vi.fn>;
  stopDrag: ReturnType<typeof vi.fn>;
  setMeasured: ReturnType<typeof vi.fn>;
  setSelectedNodes: ReturnType<typeof vi.fn>;
  screenToFlowPosition: ReturnType<typeof vi.fn>;
  setCenter: ReturnType<typeof vi.fn>;
  getZoom: ReturnType<typeof vi.fn>;
  performDragCreate: { current: ReturnType<typeof vi.fn> };
}

function harness(patch: Partial<FlowHandlerDeps> = {}): Harness {
  const fns = {
    apply: vi.fn(),
    check: vi.fn<(change: BoardChange) => EditResult | null>(() => null),
    toast: vi.fn(),
    onCancelTask: vi.fn(),
    selectNodes: vi.fn(),
    selectEdges: vi.fn(),
    startDrag: vi.fn(() => 0),
    stopDrag: vi.fn(),
    setMeasured: vi.fn(),
    setSelectedNodes: vi.fn(),
    screenToFlowPosition: vi.fn((client: { x: number; y: number }) => ({ x: client.x * 2, y: client.y * 2 })),
    setCenter: vi.fn(async () => true),
    getZoom: vi.fn(() => 0.5),
    performDragCreate: { current: vi.fn() },
  };
  const refs = flowBookkeeping();
  const deps: FlowHandlerDeps = {
    board: emptyBoard(),
    table: BUILTIN_TABLE,
    locked: new Set<string>(),
    apply: fns.apply,
    check: fns.check,
    toast: fns.toast,
    onCancelTask: fns.onCancelTask,
    nav: { selectNodes: fns.selectNodes, selectEdges: fns.selectEdges, startDrag: fns.startDrag, stopDrag: fns.stopDrag },
    setMeasured: fns.setMeasured,
    setSelectedNodes: fns.setSelectedNodes,
    performDragCreate: fns.performDragCreate,
    screenToFlowPosition: fns.screenToFlowPosition,
    setCenter: fns.setCenter,
    getZoom: fns.getZoom,
    wrapper: wrapperOf(null),
    measured: {},
    refs,
    ...patch,
  };
  return { deps, refs, ...fns };
}

const mouseUp = { clientX: 12, clientY: 34 } as unknown as MouseEvent;

/** 松手时的连接状态：默认从参考图的 out 端口拖出，落在空白处。 */
function dropState(patch: Partial<DropState> = {}): DropState {
  return { isValid: false, fromHandle: { nodeId: "ref1", id: "out", type: "source" }, toHandle: null, fromNode: null, toNode: null, ...patch };
}

const PANEL = ".react-flow__panel, .react-flow__node-toolbar";

/** 按选择器查表回答 closest 的元素；表里没有的选择器当作不命中。 */
function element(matching: Record<string, Element | null>): Element {
  return { closest: (selector: string) => matching[selector] ?? null } as unknown as Element;
}

/** 命中节点卡片。 */
function nodeCardElement(id: string): Element {
  return element({ ".react-flow__node": { getAttribute: (name: string) => (name === "data-id" ? id : null) } as unknown as Element });
}

/** 画布空白。 */
const paneElement = () => element({ ".react-flow__node": null, ".react-flow": {} as Element, [PANEL]: null });

/** 工具栏 / 小地图 / 控件（不是落点）。 */
const chromeElement = () => element({ ".react-flow__node": null, ".react-flow": {} as Element, [PANEL]: {} as Element });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("跨渲染记账", () => {
  it("初始不拖、不缩放、没有待豁免的删除", () => {
    expect(flowBookkeeping()).toEqual({ dragId: 0, dragSeq: 0, dragCopies: 0, resizeId: 0, resizeSeq: 0, cancelled: [] });
  });
});

describe("节点变更", () => {
  it("选中变更交给选区句柄，不写画板", () => {
    const h = harness();
    const changes: NodeChange[] = [{ type: "select", id: "t1", selected: true }];
    flowHandlers(h.deps).onNodesChange(changes);
    expect(h.selectNodes).toHaveBeenCalledWith(changes);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.setMeasured).not.toHaveBeenCalled();
  });

  it("没有位置 / 没有尺寸的变更不算移动与测量", () => {
    const h = harness();
    flowHandlers(h.deps).onNodesChange([{ type: "position", id: "t1" }, { type: "dimensions", id: "t1" }]);
    expect(h.setMeasured).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("拖动中的位置写成一次 move；拖动之外（没有拖动编号）drag 为 null", () => {
    const h = harness();
    flowHandlers(h.deps).onNodesChange([{ type: "position", id: "t1", position: { x: 5, y: 6 } }]);
    expect(h.apply).toHaveBeenCalledWith({ kind: "move", moves: [["t1", [5, 6]]], drag: null });
  });

  it("拖动中带上合并键与 Alt + 拖的副本数", () => {
    const h = harness();
    h.refs.dragId = 3;
    h.refs.dragCopies = 2;
    flowHandlers(h.deps).onNodesChange([{ type: "position", id: "t1", dragging: true, position: { x: 5, y: 6 } }]);
    expect(h.apply).toHaveBeenCalledWith({ kind: "move", moves: [["t1", [5, 6]]], drag: { id: 3, copies: 2 } });
  });

  it("普通测量只更新画布 state：值没变保留原对象，变了给新对象", () => {
    const h = harness();
    flowHandlers(h.deps).onNodesChange([{ type: "dimensions", id: "t1", dimensions: { width: 120, height: 80 } }]);
    const updater = h.setMeasured.mock.calls[0][0] as (m: Record<string, { width?: number; height?: number }>) => Record<string, { width?: number; height?: number }>;
    const before = {};
    expect(updater(before)).toEqual({ t1: { width: 120, height: 80 } });
    const same = { t1: { width: 120, height: 80 } };
    expect(updater(same)).toBe(same);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("拖角缩放与同批位置一起写，位置不另算移动", () => {
    const h = harness();
    const changes: NodeChange[] = [
      { type: "dimensions", id: "t1", resizing: true, dimensions: { width: 300, height: 200 } },
      { type: "position", id: "t1", position: { x: 7, y: 8 } },
    ];
    flowHandlers(h.deps).onNodesChange(changes);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith({ kind: "resize", resize: 1, boxes: [{ id: "t1", width: 300, height: 200, pos: [7, 8] }] });
  });

  it("一次缩放共用一个合并键；没有同批位置时 pos 为 null", () => {
    const h = harness();
    const handlers = flowHandlers(h.deps);
    handlers.onNodesChange([{ type: "dimensions", id: "t1", resizing: true, dimensions: { width: 300, height: 200 } }]);
    handlers.onNodesChange([{ type: "dimensions", id: "t1", resizing: true, dimensions: { width: 310, height: 210 } }]);
    expect(h.apply.mock.calls.map(([change]) => (change as { resize: number }).resize)).toEqual([1, 1]);
    expect(h.apply.mock.calls[1][0]).toMatchObject({ boxes: [{ id: "t1", pos: null }] });
  });

  it("松开时报 resizing: false：这次缩放结束，下一次重新编号", () => {
    const h = harness();
    h.refs.resizeId = 5;
    const handlers = flowHandlers(h.deps);
    handlers.onNodesChange([{ type: "dimensions", id: "t1", resizing: false, dimensions: { width: 300, height: 200 } }]);
    expect(h.refs.resizeId).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    handlers.onNodesChange([{ type: "dimensions", id: "t1", resizing: true, dimensions: { width: 300, height: 200 } }]);
    expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ kind: "resize", resize: 1 }));
  });
});

describe("连线变更", () => {
  it("只有选中在这里处理", () => {
    const h = harness();
    flowHandlers(h.deps).onEdgesChange([{ type: "select", id: "e1", selected: true }, { type: "remove", id: "e2" }]);
    expect(h.selectEdges).toHaveBeenCalledWith([{ type: "select", id: "e1", selected: true }]);
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe("拖拽起停", () => {
  it("拖动开始：新合并键，多选拖动的节点数组交给选区句柄，Alt + 拖的副本数记下来", () => {
    const h = harness();
    h.startDrag.mockReturnValue(2);
    const handlers = flowHandlers(h.deps);
    handlers.onNodeDragStart({ altKey: true }, xyNode("t1"), [xyNode("t1"), xyNode("t2")]);
    expect(h.startDrag).toHaveBeenCalledWith({ altKey: true }, [xyNode("t1"), xyNode("t2")], 1);
    expect(h.refs.dragId).toBe(1);
    expect(h.refs.dragCopies).toBe(2);
    expect(h.refs.dragSeq).toBe(1);
  });

  it("单选拖动只带一个节点", () => {
    const h = harness();
    flowHandlers(h.deps).onNodeDragStart({ altKey: false }, [xyNode("t1")]);
    expect(h.startDrag).toHaveBeenCalledWith({ altKey: false }, [xyNode("t1")], 1);
    expect(h.refs.dragCopies).toBe(0);
  });

  it("拖动结束：结算副本，清掉编号", () => {
    const h = harness();
    h.refs.dragId = 4;
    flowHandlers(h.deps).onNodeDragStop();
    expect(h.stopDrag).toHaveBeenCalledWith(4);
    expect(h.refs.dragId).toBe(0);
    expect(h.refs.dragCopies).toBe(0);
  });
});

describe("连线生效", () => {
  it("缺失的 handle 记空串", () => {
    const h = harness();
    flowHandlers(h.deps).onConnect({ source: "ref1", sourceHandle: null, target: "t1", targetHandle: "image:0" });
    expect(h.apply).toHaveBeenCalledWith({ kind: "connect", connection: { source: "ref1", sourceHandle: "", target: "t1", targetHandle: "image:0" } });
  });

  it("带的 handle 原样写进连接", () => {
    const h = harness();
    flowHandlers(h.deps).onConnect({ source: "p1", sourceHandle: "out", target: "t1", targetHandle: "positive" });
    expect(h.apply).toHaveBeenCalledWith({ kind: "connect", connection: { source: "p1", sourceHandle: "out", target: "t1", targetHandle: "positive" } });
  });
});

describe("拖线松手", () => {
  it("已连上或没有起点：什么也不做", () => {
    const h = harness();
    const handlers = flowHandlers(h.deps);
    handlers.onConnectEnd(mouseUp, dropState({ isValid: true }));
    handlers.onConnectEnd(mouseUp, dropState({ fromHandle: null }));
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("落在端口上：锁定任务只提示锁定", () => {
    const h = harness({ locked: new Set(["t1"]) });
    flowHandlers(h.deps).onConnectEnd(
      mouseUp,
      dropState({ toHandle: { nodeId: "t1", id: "image:0" }, fromNode: xyNode("ref1"), toNode: xyNode("t1") }),
    );
    expect(h.toast).toHaveBeenCalledWith(LOCKED_HINT);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("落在端口上却不合法：给 canConnect 的原因", () => {
    const h = harness();
    flowHandlers(h.deps).onConnectEnd(
      mouseUp,
      dropState({ toHandle: { nodeId: "t1", id: "positive" }, fromNode: xyNode("ref1"), toNode: xyNode("t1") }),
    );
    expect(h.toast).toHaveBeenCalledWith("提示词端口只接提示词节点");
  });

  it("落在端口上且合法：不提示也不写连线（用松手时没连上的端口）", () => {
    const h = harness();
    flowHandlers(h.deps).onConnectEnd(
      mouseUp,
      dropState({ toHandle: { nodeId: "t1", id: "image:0" }, fromNode: xyNode("ref1"), toNode: xyNode("t1") }),
    );
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("落在没有被分配 id 的端口上也不报错（handleId 记空串，不是 out 端口，没有可建的节点）", () => {
    const h = harness({ elementAt: paneElement });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState({ fromHandle: { nodeId: "ref1", id: null, type: "source" } }));
    expect(h.performDragCreate.current).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("端口没有 id 时按空 handle 判定：来源端口无效", () => {
    const h = harness();
    flowHandlers(h.deps).onConnectEnd(
      mouseUp,
      dropState({ fromHandle: { nodeId: "ref1", id: null, type: "source" }, toHandle: { nodeId: "t1", id: null }, fromNode: xyNode("ref1"), toNode: xyNode("t1") }),
    );
    expect(h.toast).toHaveBeenCalledWith("来源端口无效");
  });

  it("从目标端口反向拖出时两端对调后再判定", () => {
    const h = harness();
    const b = board([reference("ref1"), task("t1")], [edge(["ref1", "out"], ["t1", "image:0"])]);
    flowHandlers({ ...h.deps, board: b }).onConnectEnd(
      mouseUp,
      dropState({ fromHandle: { nodeId: "t1", id: "image:0", type: "target" }, toHandle: { nodeId: "ref1", id: "out" }, fromNode: xyNode("t1"), toNode: xyNode("ref1") }),
    );
    expect(h.toast).toHaveBeenCalledWith("该端口已有连线");
  });

  it("落在任务卡片上：接到下一个空端口（走连线生效）", () => {
    const h = harness({ elementAt: () => nodeCardElement("t1") });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState());
    expect(h.apply).toHaveBeenCalledWith({ kind: "connect", connection: { source: "ref1", sourceHandle: "out", target: "t1", targetHandle: "image:0" } });
  });

  it("落在非任务的卡片上：不给连线也不提示", () => {
    const h = harness({ elementAt: () => nodeCardElement("ref1") });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState());
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("落在锁定的任务卡片上：提示锁定", () => {
    const h = harness({ elementAt: () => nodeCardElement("t1"), locked: new Set(["t1"]) });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState());
    expect(h.toast).toHaveBeenCalledWith(LOCKED_HINT);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("落在空白处：拖线建节点，落点换算成画布坐标", () => {
    const h = harness({ elementAt: paneElement });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState());
    expect(h.performDragCreate.current).toHaveBeenCalledWith("continueEditing", { nodeId: "ref1", handleId: "out", type: "source" }, { x: 24, y: 68 });
  });

  it("落在空白处但没有可建的节点：什么也不做", () => {
    const h = harness({ elementAt: paneElement });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState({ fromHandle: { nodeId: "ref1", id: "image:0", type: "source" } }));
    expect(h.performDragCreate.current).not.toHaveBeenCalled();
  });

  it("落在工具栏 / 控件上：不是落点，什么也不做", () => {
    const h = harness({ elementAt: chromeElement });
    flowHandlers(h.deps).onConnectEnd(mouseUp, dropState());
    expect(h.performDragCreate.current).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe("删除", () => {
  const runningDelete = () => ({ nodes: [xyNode("t1"), xyNode("ref1")], edges: [xyEdge("ref1:out->t1:image:0")] });

  it("试算被整体拒绝（动到其余锁定任务）：提示原因、不删", async () => {
    const h = harness();
    h.check.mockReturnValue({ board: emptyBoard(), step: null, hint: "t2 正在排队 / 执行，无法断开它的输入" });
    await expect(flowHandlers(h.deps).onBeforeDelete(runningDelete())).resolves.toBe(false);
    expect(h.toast).toHaveBeenCalledWith("t2 正在排队 / 执行，无法断开它的输入");
    expect(browser.ask).not.toHaveBeenCalled();
  });

  it("删排队 / 执行中的任务节点：确认后逐个取消，并记下豁免给紧随的删除", async () => {
    const h = harness({ board: board([reference("ref1"), task("t1")], [edge(["ref1", "out"], ["t1", "image:0"])]), locked: new Set(["t1"]) });
    vi.mocked(browser.ask).mockResolvedValue(true);
    const input = runningDelete();
    await expect(flowHandlers(h.deps).onBeforeDelete(input)).resolves.toStrictEqual(input);
    expect(browser.ask).toHaveBeenCalledWith(DELETE_TASK_TEXT.confirm(1), {
      title: DELETE_TASK_TEXT.title,
      kind: "warning",
      okLabel: DELETE_TASK_TEXT.ok,
      cancelLabel: DELETE_TASK_TEXT.cancel,
    });
    expect(h.onCancelTask).toHaveBeenCalledWith("t1");
    expect(h.refs.cancelled).toEqual(["t1"]);
    expect(h.check).toHaveBeenCalledWith({ kind: "delete", nodes: ["t1", "ref1"], edges: [{ from: ["ref1", "out"], to: ["t1", "image:0"] }], cancelled: ["t1"] });
  });

  it("不确认就不删，也不取消任务", async () => {
    const h = harness({ locked: new Set(["t1"]) });
    vi.mocked(browser.ask).mockResolvedValue(false);
    await expect(flowHandlers(h.deps).onBeforeDelete(runningDelete())).resolves.toBe(false);
    expect(h.onCancelTask).not.toHaveBeenCalled();
    expect(h.refs.cancelled).toEqual([]);
  });

  it("没有锁定任务时不弹确认", async () => {
    const h = harness();
    const input = { nodes: [xyNode("ref1")], edges: [] as Edge[] };
    await expect(flowHandlers(h.deps).onBeforeDelete(input)).resolves.toStrictEqual(input);
    expect(browser.ask).not.toHaveBeenCalled();
    expect(h.refs.cancelled).toEqual([]);
  });

  it("删除写一步画板变更：带上确认过的取消列表与画板连线的端点，然后清掉豁免", () => {
    const h = harness();
    h.refs.cancelled = ["t1"];
    const b = board([reference("ref1"), task("t1"), result("res1")], [edge(["ref1", "out"], ["t1", "image:0"]), edge(["t1", "result"], ["res1", "in"], { system: true })]);
    flowHandlers({ ...h.deps, board: b }).onDelete({ nodes: [xyNode("res1")], edges: [xyEdge("t1:result->res1:in"), xyEdge("不在画板上的连线")] });
    expect(h.apply).toHaveBeenCalledWith({ kind: "delete", nodes: ["res1"], edges: [{ from: ["t1", "result"], to: ["res1", "in"] }], cancelled: ["t1"] });
    expect(h.refs.cancelled).toEqual([]);
  });
});

describe("视口", () => {
  it("平移缩放都记成视图变更", () => {
    const h = harness();
    flowHandlers(h.deps).onMoveEnd(null, { x: 10, y: 20, zoom: 1.5 });
    expect(h.apply).toHaveBeenCalledWith({ kind: "viewport", viewport: { x: 10, y: 20, zoom: 1.5 } });
  });

  it("视口中央：取画布可见区域的中点偏左上，换算成画布坐标", () => {
    const h = harness({ wrapper: wrapperOf({ left: 100, top: 50, width: 800, height: 600 }) });
    expect(flowHandlers(h.deps).centerPosition()).toEqual({ x: 760, y: 540 });
    expect(h.screenToFlowPosition).toHaveBeenCalledWith({ x: 380, y: 270 });
  });

  it("画布还没挂上时为原点", () => {
    expect(flowHandlers(harness().deps).centerPosition()).toEqual({ x: 0, y: 0 });
  });
});

describe("运行指示跳转", () => {
  it("居中到节点中心并按需放大，同时选中该节点", () => {
    const h = harness({ measured: { t1: { width: 300, height: 200 } } });
    flowHandlers(h.deps).focusNode({ nodeId: "t1", nonce: 1 });
    expect(h.setCenter).toHaveBeenCalledWith(250, 300, { zoom: 0.8, duration: 300 });
    expect(h.setSelectedNodes).toHaveBeenCalledWith(new Set(["t1"]));
  });

  it("没测到尺寸时用存的节点尺寸；当前缩放已够大就不再放大", () => {
    const h = harness();
    h.getZoom.mockReturnValue(1.2);
    flowHandlers(h.deps).focusNode({ nodeId: "t1", nonce: 2 });
    expect(h.setCenter).toHaveBeenCalledWith(240, 330, { zoom: 1.2, duration: 300 });
  });

  it("没有跳转请求、节点不在画板上或类型不认识：什么也不做", () => {
    const h = harness();
    const handlers = flowHandlers(h.deps);
    handlers.focusNode(null);
    handlers.focusNode({ nodeId: "没有这个节点", nonce: 3 });
    const withUnknown = { ...h.deps, board: board([{ type: "unknown", id: "u1", raw: {} }]) };
    flowHandlers(withUnknown).focusNode({ nodeId: "u1", nonce: 4 });
    expect(h.setCenter).not.toHaveBeenCalled();
    expect(h.setSelectedNodes).not.toHaveBeenCalled();
  });
});
