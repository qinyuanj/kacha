// 画布节点数据的派生：四型节点各自的 data、图片尺寸、共用的位置 / 选中 / 测量回传 / 类名，以及「图N」引导、端口槽与运行条目。
// 纯数据：Board 与界面事实都用字面量构造，不渲染 React；Board 只 import type，运行期不碰 core/board（它会牵进 contracts JSON）。
import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, PromptNode, ReferenceNode, Region, ResultNode, TaskNode } from "../core/board";
import { BUILTIN_TABLE, findModel } from "../core/capabilities";
import { TASK_BUSY } from "../core/iterate";
import { portKey, type DragState } from "../core/ports";
import type { TaskStatus } from "../core/run";
import type { NodeRunState } from "../core/runner";
import type { Discovery } from "../core/settings";
import { canvasNodes, type CanvasNodeInput } from "./canvasNodes";
import type { PromptFlowNode, ReferenceFlowNode, ResultFlowNode, TaskFlowNode } from "./nodes";

const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };
const FLASH = "doubao-seedream-5-0-flash-260915";
const QWEN = "qwen-image-3.0";
/** 两个模型都在网关的发现列表里：任务视图据此不报「网关未提供」。 */
const LIVE: Discovery = { source: "live", ids: [FLASH, QWEN], fetchedAt: "" };
/** 两个矩形的区域指示：矩形是 [x1, y1, x2, y2]（归一化）；渲染方式按当前模型推导，这里的记录值只是创建时的事实。 */
const REGION: Region = {
  rects: [
    [0.1, 0.1, 0.3, 0.3],
    [0.5, 0.5, 0.7, 0.7],
  ],
  render: "highlight_overlay",
};

function board(nodes: BoardNode[] = [], edges: BoardEdge[] = []): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

function prompt(id: string, text = "", patch: Partial<PromptNode> = {}): PromptNode {
  return { id, type: "prompt", pos: [0, 0], size: [240, 160], extra: {}, text, ...patch };
}

function reference(id: string, patch: Partial<ReferenceNode> = {}): ReferenceNode {
  return { id, type: "reference", pos: [0, 0], size: [240, 100], extra: {}, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png`, ...patch };
}

function result(id: string, patch: Partial<ResultNode> = {}): ResultNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [220, 300],
    extra: {},
    task_id: `task-${id}`,
    file: "result.png",
    path: `tasks/${id}/result.png`,
    layer_count: 0,
    record: { model: QWEN, prompt: "", negative_prompt: "", size_spec: SPEC_2K, submitted_at: "" },
    ...patch,
  };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [0, 0],
    size: [280, 260],
    extra: {},
    model: QWEN,
    size_spec: SPEC_2K,
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    ...patch,
  };
}

function edge(from: [string, string], to: [string, string], patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {}, ...patch };
}

/** 画布组件接线时给的那一包事实（在这里给每个字段一个空事实，用例只覆盖自己关心的那几个）。 */
function defaults(): CanvasNodeInput {
  const b = board();
  return {
    board: b,
    table: BUILTIN_TABLE,
    userRoot: "/root",
    selected: new Set(),
    measured: {},
    hidden: new Set(),
    lineageNodes: new Set(),
    drag: null,
    focusPrompt: null,
    promptDrafts: new Map(),
    missing: new Set(),
    imageInfos: new Map(),
    alphaByNode: new Map(),
    discovery: LIVE,
    concurrency: 1,
    expanded: new Set(),
    locked: new Set(),
    runStateOf: () => undefined,
    statusOf: () => null,
    menuFacts: (selected) => ({ board: b, table: BUILTIN_TABLE, selected, locked: new Set(), expanded: new Set(), undoLabel: null, redoLabel: null }),
  };
}

/** 覆盖若干事实后的输入；menuFacts 按合并后的输入现算（与 BoardCanvas 里同一构造）。 */
function makeInput(patch: Partial<CanvasNodeInput> = {}): CanvasNodeInput {
  const input: CanvasNodeInput = { ...defaults(), ...patch };
  input.menuFacts =
    patch.menuFacts ?? ((selected) => ({ board: input.board, table: input.table, selected, locked: input.locked, expanded: input.expanded, undoLabel: null, redoLabel: null }));
  return input;
}

const dataOf = <T>(node: Node): T => node.data as unknown as T;
const nodeById = (nodes: Node[], id: string): Node => nodes.find((n) => n.id === id)!;

describe("提示词节点", () => {
  it("data 带编辑三选一、一次性聚焦请求、未提交草稿、端口色与「图N」引导", () => {
    const b = board(
      [prompt("p1", "一只猫"), task("t1", { last_submitted: { step: 1 } }), reference("ref1", { display_name: "猫.png" })],
      [
        edge(["p1", "out"], ["t1", "positive"]),
        edge(["p1", "out"], ["t1", "negative"]),
        edge(["ref1", "out"], ["t1", "image:0"], { region: REGION }),
      ],
    );
    const nodes = canvasNodes(makeInput({ board: b, focusPrompt: "p1", promptDrafts: new Map([["p1", "还没想好"]]) }));
    const data = dataOf<PromptFlowNode["data"]>(nodeById(nodes, "p1"));
    expect(data.node).toBe(b.nodes[0]);
    expect(data.recorded).toBe(true);
    expect(data.autoFocus).toBe(true);
    expect(data.draft).toBe("还没想好");
    expect(data.portKind).toBe("positive");
    expect(data.guides).toEqual([{ taskId: "t1", label: "qwen-image-3.0", images: [{ port: 1, label: "猫.png", absPath: "/root/ref1.png", rects: REGION.rects }] }]);
  });

  it("没接任务 / 没有草稿 / 没有聚焦请求时给空引导与默认值", () => {
    const nodes = canvasNodes(makeInput({ board: board([prompt("p1", "一只猫")]) }));
    const data = dataOf<PromptFlowNode["data"]>(nodes[0]);
    expect(data.recorded).toBe(false);
    expect(data.autoFocus).toBe(false);
    expect(data.draft).toBeNull();
    expect(data.portKind).toBe("positive");
    expect(data.guides).toEqual([]);
  });

  it("只连负向端口的提示词为负向色", () => {
    const b = board([prompt("p1", "别画手"), task("t1")], [edge(["p1", "out"], ["t1", "negative"])]);
    const data = dataOf<PromptFlowNode["data"]>(canvasNodes(makeInput({ board: b }))[0]);
    expect(data.portKind).toBe("negative");
  });

  it("引导只收可点的图片来源：同一任务只列一次，读不到来源的线与指向非任务节点的线都不计", () => {
    const b = board(
      [prompt("p1", "一只猫"), task("t1"), task("t2", { model: "unknown-model" }), reference("ref1", { display_name: "猫.png" }), result("res2")],
      [
        edge(["p1", "out"], ["t1", "positive"]),
        edge(["p1", "out"], ["t1", "negative"]),
        edge(["ref1", "out"], ["t1", "image:0"], { region: REGION }),
        // 来源节点不存在：拿不到绝对路径，不成为可点条目。
        edge(["ghost", "out"], ["t1", "image:1"]),
        // 提示词连到非任务节点：不进引导。
        edge(["p1", "out"], ["res2", "positive"]),
        edge(["p1", "out"], ["t2", "positive"]),
        edge(["res2", "out"], ["t2", "image:0"]),
      ],
    );
    const data = dataOf<PromptFlowNode["data"]>(canvasNodes(makeInput({ board: b }))[0]);
    expect(data.guides).toEqual([
      { taskId: "t1", label: "qwen-image-3.0", images: [{ port: 1, label: "猫.png", absPath: "/root/ref1.png", rects: REGION.rects }] },
      // 模型不在能力表内：标签回落模型 id；结果节点的标签是文件名。
      { taskId: "t2", label: "unknown-model", images: [{ port: 1, label: "result.png", absPath: "/root/tasks/res2/result.png", rects: [] }] },
    ]);
  });

  it("任务没有可点的图片来源时不出现在引导里", () => {
    const b = board([prompt("p1", "一只猫"), task("t1")], [edge(["p1", "out"], ["t1", "positive"]), edge(["ghost", "out"], ["t1", "image:0"])]);
    const data = dataOf<PromptFlowNode["data"]>(canvasNodes(makeInput({ board: b }))[0]);
    expect(data.guides).toEqual([]);
  });
});

describe("参考图与结果节点", () => {
  it("参考图没接任务时按新建任务会用的默认模型提示输入规则；缺图时高度交给占位内容", () => {
    const b = board([reference("ref1", { size: [240, 100] })]);
    const nodes = canvasNodes(makeInput({ board: b, missing: new Set(["ref1"]) }));
    const data = dataOf<ReferenceFlowNode["data"]>(nodes[0]);
    expect(data.node).toBe(b.nodes[0]);
    expect(data.missing).toBe(true);
    expect(data.rules).toHaveLength(1);
    // 独立期望值（不照抄能力表）：只有 Flash 收 heic / heif，默认模型是 Flash。
    expect(data.rules[0].formats).toContain("heic");
    // 缺图：只带宽度（高度随占位内容），宽度按存的 size。
    expect(nodes[0].width).toBe(240);
    expect(nodes[0].height).toBeUndefined();
  });

  it("参考图接了任务时按下游任务的模型提示，并按读到的图片信息算显示比例", () => {
    const b = board([reference("ref1", { size: [240, 100] }), task("t1", { model: FLASH })], [edge(["ref1", "out"], ["t1", "image:0"])]);
    const imageInfos = new Map([["/root/ref1.png", { sha256: "", bytes: 1, width: 400, height: 200, format: "png", has_alpha: false }]]);
    const nodes = canvasNodes(makeInput({ board: b, imageInfos }));
    const data = dataOf<ReferenceFlowNode["data"]>(nodes[0]);
    expect(data.missing).toBe(false);
    expect(data.rules).toEqual([findModel(BUILTIN_TABLE, FLASH)!.input_image_rule]);
    // 宽 240 不变，高按图片比例 200/400：120。
    expect([nodes[0].width, nodes[0].height]).toEqual([240, 120]);
  });

  it("图片信息没读到或读不出时按存的 size 比例；缺图标记来自缺图集合", () => {
    const b = board([reference("ref1", { size: [240, 100] }), result("res1", { size: [240, 100] })]);
    const nodes = canvasNodes(makeInput({ board: b, imageInfos: new Map([["/root/ref1.png", null]]), missing: new Set(["res1"]) }));
    // 240 / (100/240) 取整后仍是 240 宽、100 高。
    expect([nodes[0].width, nodes[0].height]).toEqual([240, 100]);
    expect(dataOf<ResultFlowNode["data"]>(nodes[1]).missing).toBe(true);
    expect([nodes[1].width, nodes[1].height]).toEqual([240, undefined]);
  });

  it("结果节点没接任务不提示输入规则，接了任务才按下游模型提示", () => {
    const lone = canvasNodes(makeInput({ board: board([result("res1", { size: [220, 300] })]) }));
    expect(dataOf<ResultFlowNode["data"]>(lone[0]).rules).toEqual([]);
    // 没有图片信息时按存的 size 比例：300/220。
    expect([lone[0].width, lone[0].height]).toEqual([220, 300]);

    const b = board([result("res1"), task("t1", { model: QWEN })], [edge(["res1", "out"], ["t1", "image:0"])]);
    const connected = dataOf<ResultFlowNode["data"]>(canvasNodes(makeInput({ board: b }))[0]);
    expect(connected.rules).toEqual([findModel(BUILTIN_TABLE, QWEN)!.input_image_rule]);
  });
});

describe("生成任务节点", () => {
  const taskBoard = (): Board =>
    board(
      [prompt("p1", "一只猫"), reference("ref1", { display_name: "猫.png" }), task("t1")],
      [
        edge(["p1", "out"], ["t1", "positive"]),
        edge(["ref1", "out"], ["t1", "image:0"], { region: REGION }),
        // 来源节点不存在：端口行仍占位，标签为「?」、没有路径。
        edge(["ghost", "out"], ["t1", "image:1"]),
      ],
    );

  const RUNNING: TaskStatus = { kind: "running", startedAt: 7 };
  const MULTI: NodeRunState = {
    copies: [
      { taskId: "a", status: { kind: "failed", label: "超时" } },
      { taskId: "b", status: RUNNING },
    ],
    counts: { failed: 1, running: 1 },
    total: 2,
  };

  it("data 汇总端口、任务视图、锁定 / 工作流 / 区域渲染、端口槽（含叠加锁定行）、状态摘要与运行条目", () => {
    const b = taskBoard();
    const nodes = canvasNodes(
      makeInput({
        board: b,
        locked: new Set(["t1"]),
        expanded: new Set(["t1"]),
        runStateOf: (id) => (id === "t1" ? MULTI : undefined),
        statusOf: () => RUNNING,
      }),
    );
    const data = dataOf<TaskFlowNode["data"]>(nodeById(nodes, "t1"));
    expect(data.node).toBe(b.nodes[2]);
    expect(data.view.reasons).toEqual([]);
    expect(data.view.model).toEqual({ state: "ok", label: "qwen-image-3.0" });
    expect(data.locked).toBe(true);
    expect(data.workflow).toBe("image_edit");
    expect(data.ports).toEqual({ negative: true, imageSlots: 2, maxReferences: 3, layerDecomposition: false, transparentBackground: false });
    expect(data.regionRender).toBe("highlight_overlay");
    expect(data.hasPositive).toBe(true);
    expect(data.status).toEqual(RUNNING);
    expect(data.summary).toEqual({ text: "执行中 1 · 失败 1", detail: "失败 · 超时\n执行中", tone: { tone: "failed", spinning: true } });
    expect(data.expanded).toBe(true);
    // 运行按钮与上下文菜单同一条目：锁定时同一个置灰原因。
    expect([data.run.action, data.run.disabledReason]).toEqual(["run", TASK_BUSY]);
    expect(data.slots).toEqual([
      {
        kind: "image",
        port: 1,
        userPort: 1,
        label: "猫.png",
        absPath: "/root/ref1.png",
        handleIndex: 0,
        rects: REGION.rects,
        firstRegion: 0,
        edgeRef: { from: ["ref1", "out"], to: ["t1", "image:0"] },
      },
      // 高亮叠加区域的锁定行：从属原图、不占用户序号、没有自己的连线。
      { kind: "overlay", port: 2, userPort: 1, label: "猫.png", absPath: null, handleIndex: null, rects: [], firstRegion: 0, edgeRef: null },
      {
        kind: "image",
        port: 3,
        userPort: 2,
        label: "?",
        absPath: null,
        handleIndex: 1,
        rects: [],
        // 排在它前面的图片线有 2 个区域，区域编号从 2 起。
        firstRegion: 2,
        edgeRef: { from: ["ghost", "out"], to: ["t1", "image:1"] },
      },
    ]);
  });

  it("没锁定、没有运行状态时运行条目可点、摘要与状态为空", () => {
    const data = dataOf<TaskFlowNode["data"]>(canvasNodes(makeInput({ board: taskBoard() }))[2]);
    expect(data.locked).toBe(false);
    expect(data.expanded).toBe(false);
    expect(data.status).toBeNull();
    expect(data.summary).toBeNull();
    expect([data.run.action, data.run.disabledReason]).toEqual(["run", null]);
  });

  it("只有一份时不给多份摘要（按单份状态显示）", () => {
    const one: NodeRunState = { copies: [{ taskId: "a", status: { kind: "cancelled", gatewayMayContinue: false } }], counts: { cancelled: 1 }, total: 1 };
    const data = dataOf<TaskFlowNode["data"]>(canvasNodes(makeInput({ board: taskBoard(), runStateOf: () => one }))[2]);
    expect(data.summary).toBeNull();
  });
});

describe("四型节点共用的字段", () => {
  it("位置、选中、隐藏、测量回传与类名随输入变化", () => {
    const b = board([prompt("p1", "一只猫", { pos: [12, 34] }), task("t1"), reference("ref1")]);
    const measured = { t1: { width: 300, height: 200 } };
    const nodes = canvasNodes(makeInput({ board: b, selected: new Set(["p1"]), hidden: new Set(["ref1"]), measured, lineageNodes: new Set(["p1"]) }));
    const p1 = nodeById(nodes, "p1");
    expect(p1.position).toEqual({ x: 12, y: 34 });
    expect(p1.selected).toBe(true);
    expect(p1.hidden).toBe(false);
    // 谱系上的节点发光；有选中时不在谱系上的节点去强调。
    expect(p1.className).toBe("in-lineage");
    expect(nodeById(nodes, "t1").className).toBe("dimmed");
    expect(nodeById(nodes, "t1").measured).toBe(measured.t1);
    expect(nodeById(nodes, "ref1").hidden).toBe(true);
  });

  it("还没回传测量结果的节点共用一个空对象（承重：不能让 xyflow 清掉已测得的 handleBounds）", () => {
    const nodes = canvasNodes(makeInput({ board: board([prompt("p1"), task("t1")]) }));
    expect(nodes[0].measured).toEqual({});
    expect(nodes[0].measured).toBe(nodes[1].measured);
    // 没有选中、不在谱系、没拖线：没有类名。
    expect(nodes[0].className).toBeUndefined();
  });

  it("拖线中：起点与合法落点不去强调，其余节点去强调", () => {
    const drag: DragState = { from: { nodeId: "p1", handleId: "out", type: "source" }, ports: new Set([portKey("t1", "positive")]) };
    const nodes = canvasNodes(makeInput({ board: board([prompt("p1"), task("t1"), reference("ref1")]), drag }));
    expect(nodeById(nodes, "p1").className).toBeUndefined();
    expect(nodeById(nodes, "t1").className).toBeUndefined();
    expect(nodeById(nodes, "ref1").className).toBe("dimmed");
  });
});

describe("节点列表", () => {
  it("不认识的节点类型不渲染，其余顺序与画板一致", () => {
    const b = board([{ type: "unknown", id: "u1", raw: {} }, prompt("p1", "一只猫"), reference("ref1")]);
    const nodes = canvasNodes(makeInput({ board: b }));
    expect(nodes.map((n) => n.id)).toEqual(["p1", "ref1"]);
    expect(nodes.map((n) => n.type)).toEqual(["prompt", "reference"]);
  });
});
