import { describe, expect, it } from "vitest";
import { newBoard, type Board, type BoardNode } from "./board";
import { collapsedMembers, stageBoxes, STAGE_PADDING, suggestKeep } from "./stages";

const ref = (id: string, pos: [number, number], size: [number, number] = [100, 50]): BoardNode => ({ id, type: "reference", pos, size, extra: {}, path: `${id}.png`, sha256: "0", display_name: id });

const staged = (): Board => ({
  ...newBoard(),
  nodes: [ref("a", [0, 0]), ref("b", [200, 100]), ref("c", [1000, 1000])],
  stages: [
    { id: "s1", name: "第一轮", nodes: ["a", "b", "gone"], collapsed: false, extra: {} },
    { id: "s2", name: "第二轮", nodes: ["c"], collapsed: true, extra: {} },
  ],
});

describe("阶段在画布上的呈现", () => {
  it("收起的阶段里的节点不显示；展开的照常", () => {
    expect([...collapsedMembers(staged())]).toEqual(["c"]);
  });

  it("阶段框包住全部成员并留边距；显示尺寸优先于存的尺寸，不在画板上的成员忽略", () => {
    const sizeOf = (id: string) => (id === "b" ? { width: 300, height: 200 } : undefined);
    const [s1, s2] = stageBoxes(staged(), sizeOf);
    const p = STAGE_PADDING;
    expect(s1).toMatchObject({ stage: { id: "s1" }, x: -p, y: -p, width: 500 + 2 * p, height: 300 + 2 * p, count: 2 });
    expect(s2).toMatchObject({ stage: { id: "s2" }, x: 1000 - p, y: 1000 - p, count: 1 });
  });

  it("成员都不在画板上的阶段不画", () => {
    const b = { ...staged(), stages: [{ id: "s", name: "空", nodes: ["gone"], collapsed: false, extra: {} }] };
    expect(stageBoxes(b, () => undefined)).toEqual([]);
  });

  it("只读查看时收起的阶段按展开尺寸画（不改画板）", () => {
    const board = staged();
    const boxes = stageBoxes(board, (id) => (id === "a" ? { width: 300, height: 200 } : undefined), true);
    const s2 = board.stages![1];
    expect(boxes.find((b) => b.stage.id === s2.id)).toMatchObject({
      stage: { ...s2, collapsed: false },
      x: 1000 - STAGE_PADDING,
      y: 1000 - STAGE_PADDING,
      width: 100 + 2 * STAGE_PADDING,
      height: 50 + 2 * STAGE_PADDING,
      count: 1,
    });
    expect(board.stages![1].collapsed).toBe(true);
  });
});

// ---- 建议保留（#144）----

const resultNode = (id: string, taskId: string, final = false): BoardNode => ({
  id,
  type: "result",
  pos: [0, 0],
  size: [100, 100],
  task_id: taskId,
  file: `${id}.png`,
  path: `2026-01-01/${id}/${id}.png`,
  layer_count: 0,
  record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: null, ratio: null, width: null, height: null }, submitted_at: "" },
  ...(final ? { final: true as const } : {}),
  extra: {},
});

/** 把某张结果拿去当参考图：结果节点在这条连线的起点。 */
const usedAsReference = (resultId: string, taskId: string) => ({ from: [resultId, "out"] as [string, string], to: [taskId, "image:0"] as [string, string], source_layer: null, region: null, system: false, extra: {} });

const keepBoard = (nodes: BoardNode[], edges: ReturnType<typeof usedAsReference>[] = []): Board => ({ ...newBoard(), nodes, edges });

describe("建议保留", () => {
  it("同一结果列里只标画板顺序上最新的那一张", () => {
    const b = keepBoard([resultNode("r1", "t1"), resultNode("r2", "t1"), resultNode("r3", "t1")]);
    expect([...suggestKeep(b)]).toEqual(["r3"]);
  });

  it("不同结果列各标各的最新一张", () => {
    const b = keepBoard([resultNode("r1", "t1"), resultNode("r2", "t2"), resultNode("r3", "t1")]);
    expect([...suggestKeep(b)].sort()).toEqual(["r2", "r3"]);
  });

  it("最新一张已定稿：这一列不标，也不回退到次新的一张", () => {
    const b = keepBoard([resultNode("r1", "t1"), resultNode("r2", "t1", true)]);
    expect([...suggestKeep(b)]).toEqual([]);
  });

  it("最新一张已有下游连线（被拿去当参考图）：不标，也不回退到次新的一张", () => {
    const b = keepBoard([resultNode("r1", "t1"), resultNode("r2", "t1")], [usedAsReference("r2", "t9")]);
    expect([...suggestKeep(b)]).toEqual([]);
  });

  it("只标结果节点，别的节点不参与", () => {
    const b = keepBoard([ref("a", [0, 0]), resultNode("r1", "t1")]);
    expect([...suggestKeep(b)]).toEqual(["r1"]);
  });
});
