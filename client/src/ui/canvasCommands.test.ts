// 画板动作分派表：每个 BoardAction 一条，断言对应依赖被调用及参数；反例覆盖只读拒绝、锁定、定稿两态与目标类型不符。
import { describe, expect, it, vi } from "vitest";
import type { Board, BoardEdge, BoardNode } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { BoardAction, MenuTarget } from "../core/contextMenu";
import { LOCKED_HINT } from "../core/iterate";
import type { DragFrom } from "../core/ports";
import { ARCHIVE_TEXT } from "./boardText";
import { canvasCommands, canvasDragCreate, type CanvasCommandDeps } from "./canvasCommands";
import type { BoardActions } from "./context";

const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };

function board(nodes: BoardNode[] = []): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges: [], extra: {} };
}

/** 定稿（final）= 结果节点上的标记；定稿动作的两态靠它区分。 */
function result(id: string, final = false): BoardNode {
  const node = {
    id,
    type: "result" as const,
    pos: [0, 0] as [number, number],
    size: [220, 300] as [number, number],
    extra: {},
    task_id: `t-${id}`,
    file: "result.png",
    path: `x/${id}/result.png`,
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "", negative_prompt: "", size_spec: SPEC_2K, submitted_at: "" },
  };
  return final ? { ...node, final: true } : node;
}

const EDGE: BoardEdge = { from: ["p", "out"], to: ["t", "positive"], source_layer: null, region: null, system: false, extra: {} };

const PANE: MenuTarget = { kind: "pane" };
const NODE: MenuTarget = { kind: "node", nodeId: "img" };
const EDGE_TARGET: MenuTarget = { kind: "edge", edge: EDGE };
const AT = { x: 10, y: 20 };

/** 注入点各一个 spy：断言「只有该被调的那一个被调」时按名字比较。 */
function makeSpies() {
  return {
    apply: vi.fn(),
    deleteElements: vi.fn(async (_params: { nodes?: { id: string }[]; edges?: { id: string }[] }) => ({ deletedNodes: [], deletedEdges: [] })),
    previewNode: vi.fn(),
    continueEditing: vi.fn(),
    addAsReference: vi.fn(),
    generateVariant: vi.fn(),
    editRegion: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onRun: vi.fn(),
    onCancelTask: vi.fn(),
    onRegenerate: vi.fn(),
    onViewSendText: vi.fn(),
    addPrompt: vi.fn(),
    addTask: vi.fn(),
    pickReferences: vi.fn(),
    saveNodeAs: vi.fn(),
    newStage: vi.fn(),
    toggleExpand: vi.fn(),
    toast: vi.fn(),
  };
}

type Spies = ReturnType<typeof makeSpies>;

/** 被调用过的依赖名（字典序，便于整表比较）。 */
const calledIn = (spies: Spies): (keyof Spies)[] =>
  (Object.keys(spies) as (keyof Spies)[]).filter((name) => spies[name].mock.calls.length > 0).sort();

interface HarnessOptions {
  readOnly?: boolean;
  selected?: string[];
  nodes?: BoardNode[];
  locked?: string[];
}

/** 画布接线的替身：默认选区 ["img", "res"]，画板里 img 已定稿、res 未定稿。 */
function harness(options: HarnessOptions = {}) {
  const spies = makeSpies();
  const actions: BoardActions = {
    table: BUILTIN_TABLE,
    userRoot: "/~",
    availableModels: [],
    concurrency: 2,
    apply: vi.fn(),
    continueEditing: spies.continueEditing,
    addAsReference: spies.addAsReference,
    generateVariant: spies.generateVariant,
    relocate: vi.fn(),
    previewNode: spies.previewNode,
    editRegion: spies.editRegion,
    perform: vi.fn(),
    setPromptDraft: vi.fn(),
    takePromptFocus: () => false,
    nodeUnmounted: vi.fn(),
  };
  const deps: CanvasCommandDeps = {
    apply: spies.apply,
    flow: { deleteElements: spies.deleteElements },
    boardRef: { current: board(options.nodes ?? [result("img", true), result("res")]) },
    selectedRef: { current: new Set(options.selected ?? ["img", "res"]) },
    lockedRef: { current: new Set(options.locked ?? []) },
    actions,
    onUndo: spies.onUndo,
    onRedo: spies.onRedo,
    onRun: spies.onRun,
    onCancelTask: spies.onCancelTask,
    onRegenerate: spies.onRegenerate,
    onViewSendText: spies.onViewSendText,
    addPrompt: spies.addPrompt,
    addTask: spies.addTask,
    pickReferences: spies.pickReferences,
    saveNodeAs: spies.saveNodeAs,
    newStage: spies.newStage,
    toggleExpand: spies.toggleExpand,
    toast: spies.toast,
    readOnly: options.readOnly ?? false,
  };
  return { deps, spies, commands: canvasCommands(deps), dragCreate: canvasDragCreate(deps) };
}

/** BoardAction 全集：新增动作时这张表要跟着加，下面的只读 / 目标类型反例才覆盖得到。 */
const ALL_ACTIONS: readonly BoardAction[] = [
  "newPrompt",
  "newTask",
  "addReferences",
  "undo",
  "redo",
  "preview",
  "saveAs",
  "continueEditing",
  "addAsReference",
  "generateVariant",
  "delete",
  "run",
  "cancel",
  "regenerate",
  "toggleSettings",
  "viewSendText",
  "disconnect",
  "editRegion",
  "newStage",
  "removeFromStage",
  "toggleFinal",
  "exportPack",
  "downloadResults",
  "importPack",
];

/** 画布上不执行的动作：导出画板包 / 整板下载结果 / 导入画板包属于标签页。 */
const NOT_ON_CANVAS: readonly BoardAction[] = ["exportPack", "downloadResults", "importPack"];

/** 只认节点目标的动作。 */
const NODE_ONLY: readonly BoardAction[] = [
  "preview",
  "saveAs",
  "continueEditing",
  "addAsReference",
  "generateVariant",
  "run",
  "cancel",
  "regenerate",
  "toggleSettings",
  "viewSendText",
  "delete",
  "newStage",
  "removeFromStage",
  "toggleFinal",
];

/** 只认连线目标的动作。 */
const EDGE_ONLY: readonly BoardAction[] = ["disconnect", "editRegion"];

/**
 * 每个可执行动作一条：目标、落点、唯一该被调用的依赖与实参。
 * 期望值手写（不从被测代码推导）：搬代码时参数形状一旦变了就在这里报错。
 */
const CASES: { action: BoardAction; target: MenuTarget; at?: { x: number; y: number }; called: [keyof Spies, ...unknown[]] }[] = [
  { action: "newPrompt", target: PANE, at: AT, called: ["addPrompt", AT] },
  // 缺省落点交给画布（视口中央）算：分派只把 undefined 传下去。
  { action: "newPrompt", target: PANE, called: ["addPrompt", undefined] },
  { action: "newTask", target: PANE, at: AT, called: ["addTask", AT] },
  { action: "addReferences", target: PANE, at: AT, called: ["pickReferences", AT] },
  { action: "undo", target: PANE, called: ["onUndo"] },
  { action: "redo", target: PANE, called: ["onRedo"] },
  { action: "preview", target: NODE, called: ["previewNode", "img"] },
  { action: "saveAs", target: NODE, called: ["saveNodeAs", "img"] },
  { action: "continueEditing", target: NODE, called: ["continueEditing", "img"] },
  { action: "addAsReference", target: NODE, called: ["addAsReference", "img"] },
  { action: "generateVariant", target: NODE, called: ["generateVariant", "img"] },
  { action: "run", target: NODE, called: ["onRun", ["img"]] },
  { action: "cancel", target: NODE, called: ["onCancelTask", "img"] },
  { action: "regenerate", target: NODE, called: ["onRegenerate", "img"] },
  { action: "viewSendText", target: NODE, called: ["onViewSendText", "img"] },
  { action: "toggleSettings", target: NODE, called: ["toggleExpand", "img"] },
  // 删除与断开都走 React Flow 的删除流程，参数形状（{ nodes: [{ id }] } / { edges: [{ id }] }）逐字保留。
  { action: "delete", target: NODE, called: ["deleteElements", { nodes: [{ id: "img" }, { id: "res" }] }] },
  { action: "newStage", target: NODE, called: ["newStage", ["img", "res"]] },
  { action: "removeFromStage", target: NODE, called: ["apply", { kind: "removeFromStage", nodes: ["img", "res"] }] },
  { action: "toggleFinal", target: NODE, called: ["apply", { kind: "setFinal", nodes: ["img", "res"], final: true }] },
  { action: "disconnect", target: EDGE_TARGET, called: ["deleteElements", { edges: [{ id: "p:out->t:positive" }] }] },
  { action: "editRegion", target: EDGE_TARGET, called: ["editRegion", "t", { from: EDGE.from, to: EDGE.to }] },
];

describe("动作分派", () => {
  it.each(CASES)("$action 只调对应的依赖", ({ action, target, at, called: [name, ...args] }) => {
    const { commands, spies } = harness();
    commands[action]?.(target, at);
    expect(spies[name]).toHaveBeenCalledWith(...args);
    expect(calledIn(spies)).toEqual([name]);
  });

  it("表里每个动作都有实现，只有标签页那三项为 undefined", () => {
    const { commands } = harness();
    const missing = ALL_ACTIONS.filter((action) => (NOT_ON_CANVAS.includes(action) ? commands[action] !== undefined : commands[action] === undefined));
    expect(missing).toEqual([]);
  });

  it.each(NOT_ON_CANVAS)("%s 不在画布上执行", (action) => {
    const { commands, spies } = harness();
    commands[action]?.(NODE, AT);
    expect(calledIn(spies)).toEqual([]);
  });

  it.each(NODE_ONLY)("%s 在非节点目标上什么也不做", (action) => {
    const { commands, spies } = harness();
    for (const target of [PANE, EDGE_TARGET]) commands[action]?.(target, AT);
    expect(calledIn(spies)).toEqual([]);
  });

  it.each(EDGE_ONLY)("%s 在非连线目标上什么也不做", (action) => {
    const { commands, spies } = harness();
    for (const target of [PANE, NODE]) commands[action]?.(target, AT);
    expect(calledIn(spies)).toEqual([]);
  });

  it("新建类动作与撤销 / 重做不看目标：右键落在节点上也照做", () => {
    const { commands, spies } = harness();
    commands.newPrompt?.(NODE, AT);
    commands.newTask?.(NODE, AT);
    commands.addReferences?.(NODE, AT);
    commands.undo?.(NODE);
    commands.redo?.(NODE);
    expect(calledIn(spies)).toEqual(["addPrompt", "addTask", "onRedo", "onUndo", "pickReferences"]);
    expect(spies.addPrompt).toHaveBeenCalledWith(AT);
  });

  it("右键落在未选中的节点上：动作作用于该节点（选区临时换成它）", () => {
    const { commands, spies } = harness({ selected: ["res"], nodes: [result("res"), result("fresh")] });
    commands.delete?.({ kind: "node", nodeId: "fresh" });
    expect(spies.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: "fresh" }] });
  });

  it("右键落在选区内：动作作用于整个选区", () => {
    const { commands, spies } = harness();
    commands.newStage?.(NODE);
    expect(spies.newStage).toHaveBeenCalledWith(["img", "res"]);
  });

  it("锁定节点上的动作照常分派：置灰由菜单 / 动作条的 disabledReason 负责", () => {
    const { commands, spies } = harness({ locked: ["img"] });
    commands.run?.(NODE);
    expect(spies.onRun).toHaveBeenCalledWith(["img"]);
  });
});

describe("定稿两态", () => {
  it("选区里有未定稿的结果：标记定稿", () => {
    const { commands, spies } = harness({ nodes: [result("img", true), result("res")], selected: ["img", "res"] });
    commands.toggleFinal?.(NODE);
    expect(spies.apply).toHaveBeenCalledWith({ kind: "setFinal", nodes: ["img", "res"], final: true });
  });

  it("选区里的结果都定稿了：取消定稿", () => {
    const { commands, spies } = harness({ nodes: [result("img", true), result("res", true)], selected: ["img", "res"] });
    commands.toggleFinal?.(NODE);
    expect(spies.apply).toHaveBeenCalledWith({ kind: "setFinal", nodes: ["img", "res"], final: false });
  });

  it("选区里没有结果节点：不写入（菜单也不会给这一项）", () => {
    const { commands, spies } = harness({ nodes: [], selected: ["img"] });
    commands.toggleFinal?.(NODE);
    expect(calledIn(spies)).toEqual([]);
  });
});

describe("归档画板只读", () => {
  // 只读时仍可用的动作：手写期望值。core/archive 的白名单一变，这里的反例就会报错。
  const VIEW_ONLY: readonly BoardAction[] = ["preview", "saveAs"];

  it.each(ALL_ACTIONS.filter((action) => !VIEW_ONLY.includes(action) && !NOT_ON_CANVAS.includes(action)))("只读时 %s 只提示只读", (action) => {
    const { commands, spies } = harness({ readOnly: true });
    commands[action]?.(NODE, AT);
    expect(spies.toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(calledIn(spies)).toEqual(["toast"]);
  });

  it("只读时放大预览与另存为照常执行", () => {
    const { commands, spies } = harness({ readOnly: true });
    commands.preview?.(NODE);
    commands.saveAs?.(NODE);
    expect(spies.previewNode).toHaveBeenCalledWith("img");
    expect(spies.saveNodeAs).toHaveBeenCalledWith("img");
    expect(calledIn(spies)).toEqual(["previewNode", "saveNodeAs"]);
  });

  it("只读前置先于目标判定：只读画板上连线动作也只提示只读", () => {
    const { commands, spies } = harness({ readOnly: true });
    commands.disconnect?.(EDGE_TARGET);
    commands.editRegion?.(EDGE_TARGET);
    expect(spies.toast).toHaveBeenCalledTimes(2);
    expect(calledIn(spies)).toEqual(["toast"]);
  });
});

describe("拖线建节点", () => {
  const FROM: DragFrom = { nodeId: "p", handleId: "out", type: "source" };
  const LOCKED_FROM: DragFrom = { nodeId: "locked-task", handleId: "image", type: "target" };
  const DROP = { x: 30, y: 40 };

  it("以此继续编辑：接新任务，落点用松手处", () => {
    const { dragCreate, spies } = harness();
    dragCreate("continueEditing", FROM, DROP);
    expect(spies.continueEditing).toHaveBeenCalledWith("p", null, DROP);
    expect(calledIn(spies)).toEqual(["continueEditing"]);
  });

  it("新建生成任务：带上拖线起点作为提示词", () => {
    const { dragCreate, spies } = harness();
    dragCreate("newTask", FROM, DROP);
    expect(spies.addTask).toHaveBeenCalledWith(DROP, "p");
    expect(calledIn(spies)).toEqual(["addTask"]);
  });

  it("反向拖线建参考图：接到该任务的图片端口", () => {
    const { dragCreate, spies } = harness();
    dragCreate("addReferences", FROM, DROP);
    expect(spies.pickReferences).toHaveBeenCalledWith(DROP, "p");
    expect(calledIn(spies)).toEqual(["pickReferences"]);
  });

  it("锁定的任务不接参考图：只提示锁定", () => {
    const { dragCreate, spies } = harness({ locked: ["locked-task"] });
    dragCreate("addReferences", LOCKED_FROM, DROP);
    expect(spies.toast).toHaveBeenCalledWith(LOCKED_HINT);
    expect(calledIn(spies)).toEqual(["toast"]);
  });

  it("其它动作不会经拖线触发", () => {
    const { dragCreate, spies } = harness();
    dragCreate("delete", FROM, DROP);
    dragCreate("undo", FROM, DROP);
    expect(calledIn(spies)).toEqual([]);
  });

  it("拖线建节点不套只读前置：只读画板连不出线，这里照原样分派", () => {
    const { dragCreate, spies } = harness({ readOnly: true });
    dragCreate("newTask", FROM, DROP);
    expect(calledIn(spies)).toEqual(["addTask"]);
  });
});
