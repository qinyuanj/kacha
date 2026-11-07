import { describe, expect, it } from "vitest";
import { BOARD_FORMAT_VERSION, newBoard, stagesOf, type Board, type BoardEdge, type BoardNode, type ReferenceNode, type ResultNode, type TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { editBoard, type EditEnv } from "./edit";
import { emptyHistory, recordChange, undo } from "./history";
import { LOCKED_HINT } from "./iterate";
import { moveOutSources, splitStage } from "./moveOut";
import type { SizeSpec } from "./size";

const PRO = "doubao-seedream-5-0-pro-260628";
const MANUAL: SizeSpec = { tier: "2K", ratio: "1:1", width: null, height: null };

const reference = (id: string, pos: [number, number]): ReferenceNode => ({ id, type: "reference", pos, size: [200, 200], extra: {}, path: `参考/${id}.png`, sha256: "a".repeat(64), display_name: `${id}.png` });
const task = (id: string, pos: [number, number], image_ports = 0): TaskNode => ({ id, type: "task", pos, size: [280, 260], extra: {}, model: PRO, size_spec: MANUAL, image_ports, layer_decomposition: false, transparent_background: false, last_submitted: null });
const prompt = (id: string, pos: [number, number]): BoardNode => ({ id, type: "prompt", pos, size: [240, 140], extra: {}, text: `提示词 ${id}` });
const result = (id: string, pos: [number, number], layers = 0): ResultNode => ({
  id,
  type: "result",
  pos,
  size: [240, 240],
  extra: {},
  task_id: `20261107T000000Z-${id}`,
  file: "result.png",
  path: `2026-11-07/20261107T000000Z-${id}/result.png`,
  layer_count: layers,
  record: {
    model: PRO,
    prompt: "猫",
    negative_prompt: "",
    size_spec: MANUAL,
    submitted_at: "2026-11-07T00:00:00.000Z",
    ...(layers ? { layers: Array.from({ length: layers }, (_, i) => ({ file: `layers/0${i + 1}.png`, z_index: i, bounding_box: [0, 0, 1, 1] })) } : {}),
  },
});
const edge = (from: string, to: string, toPort: string, patch: Partial<BoardEdge> = {}): BoardEdge => ({ from: [from, "out"], to: [to, toPort], source_layer: null, region: null, system: false, extra: {}, ...patch });
const systemEdge = (taskId: string, resultId: string): BoardEdge => ({ from: [taskId, "result"], to: [resultId, "in"], source_layer: null, region: null, system: true, extra: {} });

/**
 * 原画板「大画板」：阶段外有参考图 ref、提示词 p0、任务 t0 与它的结果 r0（带 2 个图层）；
 * 阶段「第二轮」= 提示词 p1、任务 t1（接 p1、ref、r0 底图、r0 图层 2）与它的结果 r1、r2；
 * 阶段外的任务 t9 拿 r1 当参考图（下游连线）。
 */
function big(): Board {
  const region = { rects: [[0.1, 0.1, 0.5, 0.5]] as [number, number, number, number][], render: "highlight_overlay" as const };
  return {
    ...newBoard("大画板"),
    viewport: { zoom: 0.5, x: -100, y: -50 },
    last_model: PRO,
    nodes: [reference("ref", [0, 0]), prompt("p0", [0, 300]), task("t0", [300, 0]), result("r0", [700, 0], 2), prompt("p1", [1000, 300]), task("t1", [1300, 0], 3), result("r1", [1700, 0]), result("r2", [1700, 300]), task("t9", [2100, 0], 1)],
    edges: [
      edge("p0", "t0", "positive"),
      systemEdge("t0", "r0"),
      edge("p1", "t1", "positive"),
      edge("ref", "t1", "image:0", { region }),
      edge("r0", "t1", "image:1"),
      edge("r0", "t1", "image:2", { source_layer: 2 }),
      edge("p0", "t1", "negative"),
      systemEdge("t1", "r1"),
      systemEdge("t1", "r2"),
      edge("r1", "t9", "image:0"),
    ],
    stages: [
      { id: "s0", name: "第一轮", nodes: ["p0", "t0", "r0"], collapsed: false, extra: {} },
      { id: "s1", name: "第二轮", nodes: ["p1", "t1", "r1", "r2"], collapsed: true, extra: {} },
    ],
  };
}

const R0_SHA = "b".repeat(64);
const LAYER_SHA = "c".repeat(64);
const shas: Record<string, string> = { "2026-11-07/20261107T000000Z-r0/result.png": R0_SHA, "2026-11-07/20261107T000000Z-r0/layers/02.png": LAYER_SHA };

function split(b = big()) {
  let n = 0;
  const out = splitStage(b, "s1", { sha256: (path) => shas[path] ?? null, newId: () => `n${++n}` });
  if (!out) throw new Error("应能拆分");
  return out;
}

const byPath = (b: Board, path: string) => b.nodes.find((n) => (n.type === "reference" || n.type === "result") && n.path === path) as ReferenceNode | ResultNode | undefined;
const idOf = (b: Board, pred: (n: BoardNode) => boolean) => b.nodes.find(pred)!.id;

describe("移出为新画板：拆分结果", () => {
  it("要预先读 sha256 的只有阶段外接进来的结果图（底图与图层各一张）；参考图自带 sha256", () => {
    expect(moveOutSources(big(), "s1")).toEqual(["2026-11-07/20261107T000000Z-r0/result.png", "2026-11-07/20261107T000000Z-r0/layers/02.png"]);
    expect(moveOutSources(big(), "zz")).toEqual([]);
  });

  it("新画板以阶段名为标题，含阶段内节点与阶段内连线，阶段整体带过去（展开）", () => {
    const b = split();
    expect(b.format_version).toBe(BOARD_FORMAT_VERSION);
    expect(b.title).toBe("第二轮");
    expect(b.last_model).toBe(PRO);
    expect(b.viewport).toEqual({ zoom: 0.5, x: -100, y: -50 });
    const moved = b.nodes.filter((n) => n.type !== "reference");
    expect(moved.map((n) => n.type)).toEqual(["prompt", "task", "result", "result"]);
    // 节点换了新 id（避免与撤销后回来的原节点同 id），其余内容不变。
    const t1 = moved.find((n) => n.type === "task") as TaskNode;
    expect(t1).toEqual({ ...task("t1", [1300, 0], 3), id: t1.id });
    expect(["p1", "t1", "r1", "r2"].some((id) => b.nodes.some((n) => n.id === id))).toBe(false);
    const p1 = idOf(b, (n) => n.type === "prompt");
    const [r1, r2] = moved.filter((n) => n.type === "result").map((n) => n.id);
    expect(b.edges).toContainEqual(edge(p1, t1.id, "positive"));
    expect(b.edges).toContainEqual(systemEdge(t1.id, r1));
    expect(b.edges).toContainEqual(systemEdge(t1.id, r2));
    expect(stagesOf(b)).toEqual([{ id: expect.any(String), name: "第二轮", nodes: [p1, t1.id, r1, r2], collapsed: false, extra: {} }]);
  });

  it("指向阶段外节点的连线断开：阶段外的提示词与下游任务都不带过去", () => {
    const b = split();
    expect(b.nodes.some((n) => n.type === "prompt" && n.text === "提示词 p0")).toBe(false);
    expect(b.nodes.filter((n) => n.type === "task")).toHaveLength(1);
    expect(b.edges.some((e) => e.to[1] === "negative")).toBe(false);
    // 阶段内 3 条（p1、2 条系统连线）+ 3 条参考图连线；阶段外接进来的提示词与下游连线都断开。
    expect(b.edges).toHaveLength(6);
  });

  it("阶段外的上游图片成为参考图节点：指向同一文件、标注来源画板，接回原端口并保留区域", () => {
    const b = split();
    const t1 = idOf(b, (n) => n.type === "task");
    const ref = byPath(b, "参考/ref.png") as ReferenceNode;
    expect(ref).toMatchObject({ type: "reference", pos: [0, 0], size: [200, 200], sha256: "a".repeat(64), display_name: "ref.png", source_board: "大画板" });
    expect(b.edges).toContainEqual(edge(ref.id, t1, "image:0", { region: big().edges[3].region }));
    const base = byPath(b, "2026-11-07/20261107T000000Z-r0/result.png") as ReferenceNode;
    expect(base).toMatchObject({ type: "reference", pos: [700, 0], size: [240, 240], sha256: R0_SHA, display_name: "result.png", source_board: "大画板" });
    expect(b.edges).toContainEqual(edge(base.id, t1, "image:1"));
    // 接的是图层：参考图直接指向图层文件，连线不再带图层序号。
    const layer = byPath(b, "2026-11-07/20261107T000000Z-r0/layers/02.png") as ReferenceNode;
    expect(layer).toMatchObject({ type: "reference", sha256: LAYER_SHA, display_name: "02.png", source_board: "大画板" });
    expect(b.edges).toContainEqual(edge(layer.id, t1, "image:2"));
    // 原画板的参考图节点本身不改；新参考图不进阶段。
    expect(stagesOf(b)[0].nodes).not.toContain(ref.id);
  });

  it("同一张上游图接进阶段里多个端口时只建一个参考图节点", () => {
    const b0 = big();
    b0.edges.push(edge("ref", "t1", "image:3"));
    const b = split({ ...b0, nodes: b0.nodes.map((n) => (n.id === "t1" ? { ...n, image_ports: 4 } : n)) });
    expect(b.nodes.filter((n) => n.type === "reference" && n.path === "参考/ref.png")).toHaveLength(1);
  });

  it("阶段里的任务的结果在阶段外时仍留在原画板，跨阶段系统连线断开", () => {
    const b0 = big();
    const original = { ...b0, stages: [{ id: "s1", name: "第二轮", nodes: ["p1", "t1"], collapsed: false, extra: {} }] };
    const b = split(original);
    expect(b.nodes.filter((n) => n.type === "result")).toHaveLength(0);
    expect(stagesOf(b)[0].nodes).toHaveLength(2);
    const e: EditEnv = { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set(), imageSize: () => undefined, newId: () => "unused" };
    const removed = editBoard(original, { kind: "moveOutStage", stageId: "s1" }, e);
    expect(removed.board.nodes.filter((n) => n.type === "result").map((n) => n.id)).toEqual(["r0", "r1", "r2"]);
    expect(removed.board.edges.some((line) => line.from[0] === "t1")).toBe(false);
    expect(undo(recordChange(emptyHistory(), original, removed.step!, 0), removed.board, new Set())!.board).toEqual(original);
  });

  it("阶段不存在时不拆", () => {
    expect(splitStage(big(), "zz", { sha256: () => null, newId: () => "x" })).toBeNull();
  });
});

describe("移出为新画板：原画板", () => {
  const env = (locked: string[] = []): EditEnv => {
    let n = 0;
    return { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set(locked), imageSize: () => undefined, newId: () => `e${++n}` };
  };

  it("删去移出的节点与相关连线，阶段随之消失；是一次可撤销的用户变更，撤销后阶段恢复", () => {
    const b = big();
    const r = editBoard(b, { kind: "moveOutStage", stageId: "s1" }, env());
    expect(r.step).toEqual({ label: "移出为新画板" });
    expect(r.board.nodes.map((n) => n.id)).toEqual(["ref", "p0", "t0", "r0", "t9"]);
    expect(r.board.edges).toEqual([edge("p0", "t0", "positive"), systemEdge("t0", "r0")]);
    expect(stagesOf(r.board).map((s) => s.id)).toEqual(["s0"]);
    const back = undo(recordChange(emptyHistory(), b, r.step!, 0), r.board, new Set())!;
    expect(back.board).toEqual(b);
  });

  it("拆分与删除是同一组节点：新画板里的非参考图节点数 = 原画板少掉的节点数", () => {
    const b = big();
    const r = editBoard(b, { kind: "moveOutStage", stageId: "s1" }, env());
    expect(split(b).nodes.filter((n) => n.type !== "reference")).toHaveLength(b.nodes.length - r.board.nodes.length);
  });

  it("阶段里有运行中的任务时拒绝、原画板不变", () => {
    const b = big();
    const r = editBoard(b, { kind: "moveOutStage", stageId: "s1" }, env(["t1"]));
    expect(r.board).toBe(b);
    expect(r.step).toBeNull();
    expect(r.hint).toBe(LOCKED_HINT);
  });

  it("阶段不存在时不构成步", () => {
    expect(editBoard(big(), { kind: "moveOutStage", stageId: "zz" }, env()).step).toBeNull();
  });
});
