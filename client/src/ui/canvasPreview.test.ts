// 放大预览与「框选修改区域」的请求构造：可编辑区域目标、标题 / 绝对路径 / 图层 / 结果 id、区域轮廓。
// 纯数据，不需要渲染；画板用字面量构造（运行期不 import core/board）。
import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, PromptNode, ReferenceNode, ResultNode, TaskNode } from "../core/board";
import { BUILTIN_TABLE, type CapabilityTable } from "../core/capabilities";
import { REGION_TEXT } from "./boardText";
import { nodePreviewRequest, regionEditRequest, regionTargetsOf, type RegionEditResult } from "./canvasPreview";
import type { PreviewRequest } from "./PreviewDialog";

const SPEC = { tier: "1K", ratio: "1:1", width: null, height: null } as const;

function board(nodes: BoardNode[], edges: BoardEdge[]): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

function reference(id: string, patch: Partial<ReferenceNode> = {}): ReferenceNode {
  return { id, type: "reference", pos: [0, 0], size: [200, 220], extra: {}, path: `refs/${id}.png`, sha256: "a".repeat(64), display_name: `${id}.png`, ...patch };
}

function result(id: string, patch: Partial<ResultNode> = {}): ResultNode {
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
    ...patch,
  };
}

function task(id: string, model: string, patch: Partial<TaskNode> = {}): TaskNode {
  return { id, type: "task", pos: [0, 0], size: [280, 260], extra: {}, model, size_spec: { ...SPEC }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...patch };
}

function prompt(id: string): PromptNode {
  return { id, type: "prompt", pos: [0, 0], size: [240, 160], extra: {}, text: "" };
}

function edge(from: [string, string], to: [string, string], patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {}, ...patch };
}

const FLASH = "doubao-seedream-5-0-flash-260915";
const QWEN = "qwen-image-3.0";

/** t1 的两条图片线（第一条两个区域，第二条一个区域）与几种不给目标的线。 */
function previewBoard(): Board {
  return board(
    [reference("ref1"), reference("ref2"), task("t1", QWEN), task("t2", FLASH), task("t3", "不存在的模型"), prompt("p")],
    [
      edge(["ref1", "out"], ["t1", "image:0"], { region: { rects: [[0.1, 0.2, 0.3, 0.4], [0.5, 0.5, 0.6, 0.6]], render: "highlight_overlay", coordinate_kind: "point" } }),
      edge(["ref2", "out"], ["t1", "image:1"], { region: { rects: [[0.2, 0.2, 0.4, 0.4]], render: "marked_image" } }),
      edge(["ref1", "out"], ["t2", "image:0"]),
      edge(["ref1", "out"], ["p", "image:0"]),
      edge(["ref1", "out"], ["t1", "positive"]),
      edge(["ref1", "out"], ["t3", "image:0"]),
      edge(["p", "out"], ["t2", "image:1"]),
    ],
  );
}

const table: CapabilityTable = BUILTIN_TABLE;
const ROOT = "/~";

describe("可编辑区域目标", () => {
  it("一条图片线一个目标：标题带模型名与图序号，区域与渲染方式取自连线，坐标能力与首个区域编号按模型算", () => {
    const targets = regionTargetsOf(previewBoard(), table, "ref1");
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({
      label: REGION_TEXT.targetLabel("qwen-image-3.0", 1),
      edgeRef: { from: ["ref1", "out"], to: ["t1", "image:0"] },
      rects: [[0.1, 0.2, 0.3, 0.4], [0.5, 0.5, 0.6, 0.6]],
      render: "highlight_overlay",
      coordinateKind: "point",
      // qwen 不是 Flash 请求形态：坐标区域不可用。
      coordinateAvailable: false,
      firstRegion: 0,
    });
    expect(targets[1]).toMatchObject({ label: REGION_TEXT.targetLabel("Seedream 5.0 Flash", 1), rects: [], render: "highlight_overlay", coordinateKind: undefined, coordinateAvailable: true, firstRegion: 0 });
  });

  it("模型名取能力表的显示名；没有连线的节点没有目标", () => {
    expect(regionTargetsOf(previewBoard(), table, "ref2").map((t) => t.label)).toEqual([REGION_TEXT.targetLabel("qwen-image-3.0", 2)]);
    expect(regionTargetsOf(previewBoard(), table, "ref2")[0].firstRegion).toBe(2);
    expect(regionTargetsOf(previewBoard(), table, "t1")).toEqual([]);
  });

  it("只认图片端口与任务节点：提示词端口、非任务目标的线不给目标；能力表里查不到的模型也不给", () => {
    const targets = regionTargetsOf(previewBoard(), table, "ref1");
    expect(targets.map((t) => t.edgeRef.to)).toEqual([["t1", "image:0"], ["t2", "image:0"]]);
    expect(regionTargetsOf(previewBoard(), table, "p").map((t) => t.label)).toEqual([REGION_TEXT.targetLabel("Seedream 5.0 Flash", 2)]);
  });

  it("区域里记了别的渲染方式时按连线记的来（换模型的会话里照旧回显）", () => {
    const b = board([reference("ref1"), task("t1", QWEN)], [edge(["ref1", "out"], ["t1", "image:0"], { region: { rects: [[0, 0, 1, 1]], render: "bbox_tag" } })]);
    expect(regionTargetsOf(b, table, "ref1")[0]).toMatchObject({ render: "bbox_tag", coordinateKind: undefined });
  });
});

describe("放大预览的请求", () => {
  it("参考图：显示名、绝对路径、扇出的可编辑区域；没有图层、没有区域轮廓", () => {
    expect(nodePreviewRequest(previewBoard(), table, ROOT, "ref1")).toEqual({
      title: "ref1.png",
      absPath: "/~/refs/ref1.png",
      layers: [],
      resultId: undefined,
      regionTargets: regionTargetsOf(previewBoard(), table, "ref1"),
      regionOutlines: [],
    });
  });

  it("结果：图层带上绝对路径、resultId 带节点 id，区域轮廓取自产出任务提交快照", () => {
    const layers = [{ file: "layers/01.png", z_index: 1, bounding_box: [0, 0, 10, 10] }];
    const b = board(
      [result("res1", { record: { ...result("res1").record, layers } }), task("t1", QWEN, { last_submitted: { images: [{ kind: "reference", path: "refs/ref1.png", sha256: "a".repeat(64), region: { rects: [[0.1, 0.2, 0.3, 0.4]], render: "highlight_overlay" } }] } })],
      [edge(["t1", "result"], ["res1", "in"], { system: true })],
    );
    const req = nodePreviewRequest(b, table, ROOT, "res1")!;
    expect(req.title).toBe("res1.png");
    expect(req.absPath).toBe("/~/results/res1/res1.png");
    expect(req.layers).toEqual([{ record: layers[0], absPath: "/~/results/res1/layers/01.png" }]);
    expect(req.resultId).toBe("res1");
    expect(req.regionTargets).toEqual([]);
    expect(req.regionOutlines).toEqual([[0.1, 0.2, 0.3, 0.4]]);
  });

  it("结果没有图层记录、没有产出任务、或快照里没有图片时为空的图层与轮廓", () => {
    expect(nodePreviewRequest(board([result("res1")], []), table, ROOT, "res1")).toMatchObject({ layers: [], regionOutlines: [] });
    expect(nodePreviewRequest(board([result("res1"), task("t1", QWEN)], [edge(["t1", "result"], ["res1", "in"], { system: true })]), table, ROOT, "res1")).toMatchObject({ regionOutlines: [] });
    const noImages = board([result("res1"), task("t1", QWEN, { last_submitted: { images: [] } })], [edge(["t1", "result"], ["res1", "in"], { system: true })]);
    expect(nodePreviewRequest(noImages, table, ROOT, "res1")).toMatchObject({ regionOutlines: [] });
    // 快照里的图片本身没有区域：不贡献轮廓。
    const withoutRegion = board(
      [result("res1"), task("t1", QWEN, { last_submitted: { images: [{ kind: "result", task_id: "task-x", file: "x.png", source_layer: null, region: null }] } })],
      [edge(["t1", "result"], ["res1", "in"], { system: true })],
    );
    expect(nodePreviewRequest(withoutRegion, table, ROOT, "res1")).toMatchObject({ regionOutlines: [] });
  });

  it("只有参考图与结果节点能放大；提示词、任务与不在画板上的节点都没有请求", () => {
    expect(nodePreviewRequest(previewBoard(), table, ROOT, "p")).toBeNull();
    expect(nodePreviewRequest(previewBoard(), table, ROOT, "t1")).toBeNull();
    expect(nodePreviewRequest(previewBoard(), table, ROOT, "没有这个节点")).toBeNull();
  });
});

/** 只接受 preview 结果：别的形态直接让断言失败（调用方只有 preview 才弹窗）。 */
function previewOf(result: RegionEditResult): PreviewRequest {
  if (result.kind !== "preview") throw new Error(`期望 preview，实际 ${result.kind}`);
  return result.req;
}

describe("框选修改区域的请求", () => {
  it("按任务与端口找到那条线：标题带源节点名，打开即进入该线的区域编辑", () => {
    const b = previewBoard();
    const req = previewOf(regionEditRequest(b, table, ROOT, "t1", { from: ["ref1", "out"], to: ["t1", "image:0"] }));
    const target = regionTargetsOf(b, table, "ref1")[0];
    expect(req.title).toBe(REGION_TEXT.previewTitle("ref1.png"));
    expect(req.absPath).toBe("/~/refs/ref1.png");
    expect(req.edit).toEqual(target);
    expect(req.regionTargets).toEqual([target]);
  });

  it("结果节点用文件名", () => {
    const b = board([result("res1"), task("t1", QWEN)], [edge(["res1", "out"], ["t1", "image:0"])]);
    expect(previewOf(regionEditRequest(b, table, ROOT, "t1", { from: ["res1", "out"], to: ["t1", "image:0"] })).title).toBe(REGION_TEXT.previewTitle("res1.png"));
  });

  it("模型不支持框选区域、端口对不上、节点对不上：拒绝（由调用方给拒绝原因）", () => {
    const b = previewBoard();
    // 能力表里查不到模型：那条线没有可编辑目标。
    expect(regionEditRequest(b, table, ROOT, "t3", { from: ["ref1", "out"], to: ["t3", "image:0"] })).toEqual({ kind: "refuse" });
    // 端口对不上。
    expect(regionEditRequest(b, table, ROOT, "t1", { from: ["ref1", "out"], to: ["t1", "image:1"] })).toEqual({ kind: "refuse" });
    // 任务对不上（那个任务上没有 ref1 的图片线）。
    expect(regionEditRequest(b, table, ROOT, "t9", { from: ["ref1", "out"], to: ["t9", "image:0"] })).toEqual({ kind: "refuse" });
  });

  it("目标在但源节点不是参考图 / 结果节点（提示词接到图片端口）：静默，不提示也不弹窗", () => {
    expect(regionEditRequest(previewBoard(), table, ROOT, "t2", { from: ["p", "out"], to: ["t2", "image:1"] })).toEqual({ kind: "ignore" });
  });
});
