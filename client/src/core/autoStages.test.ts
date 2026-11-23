import { describe, expect, it } from "vitest";
import { autoStageGroups } from "./autoStages";
import { newBoard, type Board, type BoardEdge, type BoardNode, type PromptNode, type ResultNode, type Stage, type TaskNode } from "./board";
import type { SizeSpec } from "./size";

const MANUAL: SizeSpec = { tier: "2K", ratio: "1:1", width: null, height: null };

function prompt(id: string): PromptNode {
  return { id, type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: "猫" };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return { id, type: "task", pos: [400, 0], size: [280, 260], extra: {}, model: "m", size_spec: MANUAL, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...patch };
}

/** 结果节点的 task_id 是提交编号，与画板上的任务节点 id 不同。 */
function result(id: string, taskId: string): ResultNode {
  return {
    id,
    type: "result",
    pos: [800, 0],
    size: [240, 240],
    extra: {},
    task_id: taskId + "-run",
    file: id + ".png",
    path: id + ".png",
    layer_count: 0,
    record: { model: "m", prompt: "猫", negative_prompt: "", size_spec: MANUAL, submitted_at: "2026-09-16T09:15:00.000Z" },
  };
}

function edge(from: string, to: string, toPort: string): BoardEdge {
  return { from: [from, "out"], to: [to, toPort], source_layer: null, region: null, system: false, extra: {} };
}

const systemEdge = (taskId: string, resultId: string): BoardEdge => ({ from: [taskId, "result"], to: [resultId, "in"], source_layer: null, region: null, system: true, extra: {} });

function board(nodes: BoardNode[], edges: BoardEdge[] = [], stages: Stage[] = []): Board {
  return { ...newBoard(), nodes, edges, ...(stages.length ? { stages } : {}) };
}

describe("自动划分阶段：按一次生成尝试把没进阶段的节点划成组", () => {
  it("一条链：生成任务带自己的结果列与输入；下游任务不认领上游结果", () => {
    const b = board(
      [prompt("p"), task("t1", { image_ports: 1 }), result("r1", "t1"), result("r2", "t1"), task("t2", { image_ports: 1 }), result("r3", "t2")],
      [edge("p", "t1", "positive"), systemEdge("t1", "r1"), systemEdge("t1", "r2"), edge("r1", "t2", "image:0"), systemEdge("t2", "r3")],
    );
    // r1 已被上游任务认领，t2 只带自己的提示词与结果。
    const expected = [
      ["p", "t1", "r1", "r2"],
      ["t2", "r3"],
    ];
    expect(autoStageGroups(b)).toEqual(expected);
    // 同一份画板重复计算也得到同一份分组（确定性）。
    expect(autoStageGroups(b)).toEqual(expected);
  });

  it("多源并行：各尝试各自成组", () => {
    const b = board(
      [prompt("p1"), prompt("p2"), task("t1"), task("t2"), result("r1", "t1"), result("r2", "t2")],
      [edge("p1", "t1", "positive"), edge("p2", "t2", "positive"), systemEdge("t1", "r1"), systemEdge("t2", "r2")],
    );
    expect(autoStageGroups(b)).toEqual([
      ["p1", "t1", "r1"],
      ["p2", "t2", "r2"],
    ]);
  });

  it("组内成员共用的节点只归先出现的尝试", () => {
    const b = board(
      [prompt("p"), task("t1"), result("r1", "t1"), task("t2"), result("r2", "t2")],
      [edge("p", "t1", "positive"), edge("p", "t2", "positive"), systemEdge("t1", "r1"), systemEdge("t2", "r2")],
    );
    expect(autoStageGroups(b)).toEqual([
      ["p", "t1", "r1"],
      ["t2", "r2"],
    ]);
  });

  it("阶段顺序按组内第一个成员在画板上的先后，与任务节点的先后无关", () => {
    // t2 在画板上更靠前，但 t1 的提示词排在它前面；先成组的是 t1。
    const b = board(
      [prompt("p1"), task("t2"), result("r2", "t2"), prompt("p2"), task("t1"), result("r1", "t1")],
      [edge("p1", "t1", "positive"), edge("p2", "t2", "positive"), systemEdge("t2", "r2"), systemEdge("t1", "r1")],
    );
    expect(autoStageGroups(b)).toEqual([
      ["p1", "t1", "r1"],
      ["t2", "r2", "p2"],
    ]);
  });

  it("已在阶段里的节点不再参与，散着的尝试照样成组", () => {
    const b = board(
      [prompt("p1"), task("t1"), result("r1", "t1"), prompt("p2"), task("t2"), result("r2", "t2")],
      [edge("p1", "t1", "positive"), edge("p2", "t2", "positive"), systemEdge("t1", "r1"), systemEdge("t2", "r2")],
      [{ id: "s1", name: "第一轮", nodes: ["p1", "t1", "r1"], collapsed: false, extra: {} }],
    );
    expect(autoStageGroups(b)).toEqual([["p2", "t2", "r2"]]);
  });

  it("成员凑不满两个的不成组：孤立提示词、刚建的任务、单独一张结果", () => {
    expect(autoStageGroups(board([prompt("p")]))).toEqual([]);
    expect(autoStageGroups(board([task("t")]))).toEqual([]);
    expect(autoStageGroups(board([result("r", "x")]))).toEqual([]);
    // 有输入的任务是两个成员：成组。
    expect(autoStageGroups(board([prompt("p"), task("t")], [edge("p", "t", "positive")]))).toEqual([["p", "t"]]);
  });

  it("结果列里多张结果都属于产出它的任务", () => {
    const b = board([task("t"), result("r1", "t"), result("r2", "t"), result("r3", "t")], [systemEdge("t", "r1"), systemEdge("t", "r2"), systemEdge("t", "r3")]);
    expect(autoStageGroups(b)).toEqual([["t", "r1", "r2", "r3"]]);
  });

  it("任务节点已被删、结果还在：同一 task_id 的结果列照样成组", () => {
    expect(autoStageGroups(board([result("r1", "x"), result("r2", "x")]))).toEqual([["r1", "r2"]]);
  });

});
