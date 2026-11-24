// 「移出为新画板」（#93）的拆分那一半已在 1.7.0 移除（#251）；这里守的是原画板这一侧：
// 画板变更 moveOutStage 删去移出的阶段节点。界面不再产生这个变更，收口留给 #255 的死代码清理。
import { describe, expect, it } from "vitest";
import { newBoard, stagesOf, type Board, type BoardEdge, type BoardNode, type ResultNode } from "./board";
import { removeMovedStage } from "./moveOut";

const prompt = (id: string): BoardNode => ({ id, type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: id });
const task = (id: string): BoardNode => ({ id, type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: "m", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null });
const result = (id: string): ResultNode => ({
  id,
  type: "result",
  pos: [700, 0],
  size: [240, 240],
  extra: {},
  task_id: id,
  file: "result.png",
  path: `2026-11-07/${id}/result.png`,
  layer_count: 0,
  record: { model: "m", prompt: "猫", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-11-07T00:00:00.000Z" },
});
const edge = (from: string, to: string, toPort: string, system = false): BoardEdge => ({ from: [from, "out"], to: [to, toPort], source_layer: null, region: null, system, extra: {} });

/**
 * 原画板：阶段「第二轮」= 提示词 p1 与任务 t1；阶段外还有参考流程 p → t0 → r0，
 * 以及 t1 的结果 r1 落在阶段外（跨阶段的系统连线）。
 */
function board(): Board {
  return {
    ...newBoard("大画板"),
    nodes: [prompt("p"), prompt("p1"), task("t0"), task("t1"), result("r0"), result("r1")],
    edges: [edge("p", "t0", "positive"), edge("t0", "r0", "in", true), edge("p1", "t1", "positive"), edge("p", "t1", "negative"), edge("t1", "r1", "in", true)],
    stages: [{ id: "s1", name: "第二轮", nodes: ["p1", "t1"], collapsed: false, extra: {} }],
  };
}

describe("原画板删去移出的阶段节点", () => {
  it("只删阶段成员与相关连线，阶段外的节点与连线原样留下", () => {
    const r = removeMovedStage(board(), "s1");
    expect(r.nodes.map((n) => n.id)).toEqual(["p", "t0", "r0", "r1"]);
    expect(r.edges).toEqual([edge("p", "t0", "positive"), edge("t0", "r0", "in", true)]);
  });

  it("阶段外的结果不被级联带走：跨阶段的系统连线先断开，普通删除规则就带不到 r1", () => {
    const r = removeMovedStage(board(), "s1");
    expect(r.nodes.map((n) => n.id)).toContain("r1");
  });

  it("阶段不存在或没有成员时原样返回画板", () => {
    const b = board();
    expect(removeMovedStage(b, "zz")).toBe(b);
    const empty: Board = { ...b, stages: [{ id: "s0", name: "空", nodes: [], collapsed: false, extra: {} }] };
    expect(removeMovedStage(empty, "s0")).toBe(empty);
    expect(stagesOf(removeMovedStage(b, "s1")).map((s) => s.id)).toEqual(["s1"]);
  });
});
