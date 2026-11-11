// Alt + 拖复制的纯逻辑：开始（判定、原节点、复制变更）、apply 之后对齐副本、松手对调的变更参数。
import { describe, expect, it } from "vitest";
import type { Board, BoardNode, ResultNode } from "../core/board";
import type { EditResult } from "../core/edit";
import { altDragPending, altDragSettle, altDragStart } from "./altDrag";

const prompt = (id: string, pos: [number, number]): BoardNode => ({ type: "prompt", id, pos, size: [100, 100], text: id, extra: {} });

const result = (id: string, pos: [number, number]): ResultNode => ({
  type: "result",
  id,
  pos,
  size: [200, 200],
  extra: {},
  task_id: "t1",
  file: "result.png",
  path: "2026-01-01/t1/result.png",
  layer_count: 0,
  record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-01-01T00:00:00Z" },
});

const board = (nodes: BoardNode[]): Board => ({ format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges: [], extra: {} });

/** apply 的结果：新画板 + 一步撤销步；step 为 null 表示没落账。 */
const applied = (before: Board, nodes: BoardNode[], step: EditResult["step"] = { label: "复制 2" }): EditResult => ({ board: { ...before, nodes: [...before.nodes, ...nodes] }, step });

const BASE = board([prompt("a", [10, 20]), prompt("b", [0, 0]), result("r", [5, 5])]);

describe("拖动开始", () => {
  it("Alt + 拖到提示词 / 参考图 / 任务节点：副本数与可复制的原节点数一致", () => {
    expect(altDragStart(true, ["a", "b"], BASE, 7)).toEqual({
      change: { kind: "duplicate", ids: ["a", "b"], drag: { id: 7, copies: 2 } },
      originals: [
        { id: "a", pos: [10, 20] },
        { id: "b", pos: [0, 0] },
      ],
    });
  });

  it("不是 Alt：普通拖动，不复制", () => {
    expect(altDragStart(false, ["a"], BASE, 7)).toEqual({ change: null, originals: [] });
  });

  it("没拖到任何节点：不复制", () => {
    expect(altDragStart(true, [], BASE, 7)).toEqual({ change: null, originals: [] });
  });

  it("拖的只有结果节点（结果不复制）：不复制", () => {
    expect(altDragStart(true, ["r"], BASE, 7)).toEqual({ change: null, originals: [] });
  });

  it("混着结果节点时只复制能复制的那几个，复制变更仍带全部拖到的 id", () => {
    expect(altDragStart(true, ["a", "r"], BASE, 7)).toEqual({
      change: { kind: "duplicate", ids: ["a", "r"], drag: { id: 7, copies: 1 } },
      originals: [{ id: "a", pos: [10, 20] }],
    });
  });
});

describe("apply 之后对齐副本", () => {
  const start = altDragStart(true, ["a", "b"], BASE, 7);

  it("新出现的节点按顺序一一对上原节点，starts 记原节点拖动前位置", () => {
    const r = applied(BASE, [prompt("n1", [0, 0]), prompt("n2", [0, 0])]);
    expect(altDragPending(BASE, start.originals, r)).toEqual({
      pairs: [
        ["a", "n1"],
        ["b", "n2"],
      ],
      starts: [
        ["a", [10, 20]],
        ["b", [0, 0]],
      ],
    });
  });

  it("画板里原本就有的节点不算副本", () => {
    const withOld = board([...BASE.nodes, prompt("old", [1, 1])]);
    const r = applied(withOld, [prompt("n1", [0, 0])]);
    expect(altDragPending(withOld, start.originals.slice(0, 1), r)?.pairs).toEqual([["a", "n1"]]);
  });

  it("没落账（没有撤销步或 apply 被拒）时按普通拖动处理", () => {
    expect(altDragPending(BASE, start.originals, null)).toBeNull();
    expect(altDragPending(BASE, start.originals, applied(BASE, [], null))).toBeNull();
  });
});

describe("松手对调", () => {
  const pending = { pairs: [["a", "n1"]] as [string, string][], starts: [["a", [10, 20]]] as [string, [number, number]][] };

  it("换成 settleDrag 变更，copies = 对调节点数", () => {
    expect(altDragSettle(pending, 9)).toEqual({ kind: "settleDrag", drag: { id: 9, copies: 1 }, pairs: pending.pairs, starts: pending.starts });
  });

  it("没有待办复制时不写画板", () => {
    expect(altDragSettle(null, 9)).toBeNull();
  });
});
