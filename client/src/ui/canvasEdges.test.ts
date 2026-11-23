// 画布连线数据的派生：id / 端点 / 选中 / 区域徽标 / 系统连线 / 谱系高亮与去强调，以及悬浮信息。
import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, TaskNode } from "../core/board";
import { REGION_TEXT } from "./boardText";
import { canvasEdges, type CanvasEdgeInput } from "./canvasEdges";

const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };

function board(edges: BoardEdge[]): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges, extra: {} };
}

function edge(from: [string, string], to: [string, string], patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {}, ...patch };
}

function task(id: string): TaskNode {
  return { id, type: "task", pos: [0, 0], size: [280, 260], extra: {}, model: "qwen-image-3.0", size_spec: SPEC_2K, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null };
}

function input(edges: BoardEdge[], patch: Partial<CanvasEdgeInput> = {}): CanvasEdgeInput {
  return { board: board(edges), selectedEdges: new Set(), selectedNodes: new Set(), lineageEdges: new Set(), dragging: false, expanded: new Set(), ...patch };
}

describe("连线的基本字段", () => {
  it("id 与画板端点一一对应，端点 / 端口原样带过去；用户连线可删可选", () => {
    const e = edge(["p1", "out"], ["t1", "positive"]);
    const [out] = canvasEdges(input([e]));
    expect(out.id).toBe("p1:out->t1:positive");
    expect([out.source, out.sourceHandle, out.target, out.targetHandle]).toEqual(["p1", "out", "t1", "positive"]);
    expect(out.selected).toBe(false);
    expect(out.deletable).toBe(true);
    expect(out.selectable).toBe(true);
    expect(out.label).toBeUndefined();
  });

  // 系统连线的系统色与空悬浮信息由 core/ports 与 core/hoverInfo 拥有；本层只映射可删可选。
  it("系统连线不可删、不可选", () => {
    const [out] = canvasEdges(input([edge(["t1", "out"], ["res1", "in"], { system: true })]));
    expect(out.deletable).toBe(false);
    expect(out.selectable).toBe(false);
  });

  it("顺序与画板连线一致；空画板没有连线", () => {
    const edges = canvasEdges(
      input([edge(["p1", "out"], ["t1", "positive"]), edge(["p2", "out"], ["t1", "negative"]), edge(["ref1", "out"], ["t1", "image:0"])]),
    );
    expect(edges.map((e) => e.id)).toEqual(["p1:out->t1:positive", "p2:out->t1:negative", "ref1:out->t1:image:0"]);
    expect(canvasEdges(input([]))).toEqual([]);
  });
});

describe("区域徽标与悬浮信息", () => {
  it("框过区域的图片线显示区域数，悬浮信息给区域数与来源", () => {
    const [out] = canvasEdges(
      input([
        edge(["ref1", "out"], ["t1", "image:0"], {
          region: { rects: [[0.1, 0.1, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2]], render: "highlight_overlay" },
        }),
      ]),
    );
    expect(out.label).toBe(REGION_TEXT.edgeLabel(2));
  });

  it("没有区域时不给徽标", () => {
    const [out] = canvasEdges(input([edge(["res1", "out"], ["t1", "image:0"], { source_layer: 2, region: { rects: [], render: "highlight_overlay" } })]));
    expect(out.label).toBeUndefined();
  });

  it("系统图片线也按区域数给徽标", () => {
    const e = edge(["ref1", "out"], ["t1", "image:0"], {
      system: true,
      region: { rects: [[0.1, 0.1, 0.2, 0.2]], render: "highlight_overlay" },
    });
    const [out] = canvasEdges(input([e]));
    expect(out.label).toBe(REGION_TEXT.edgeLabel(1));
  });
});

describe("选中、谱系高亮与去强调", () => {
  const e = edge(["p1", "out"], ["t1", "positive"]);

  it("选中的连线按 id 对齐标出来", () => {
    const [out] = canvasEdges(input([e], { selectedEdges: new Set(["p1:out->t1:positive"]) }));
    expect(out.selected).toBe(true);
  });

  // 类名字符串的组合规则由 core/ports 拥有；本层只留「谱系 / 有选中 / 拖线三个标志接到
  // edgeClassName」这一行映射：有选中时非谱系线去强调，谱系线带 lineage。
  it("谱系高亮与「有选中时其余去强调」接到类名上", () => {
    const edges = canvasEdges(
      input([e, edge(["p2", "out"], ["t1", "negative"])], { selectedNodes: new Set(["p1"]), lineageEdges: new Set([e]) }),
    );
    expect(edges.map((x) => x.className)).toEqual(["edge-positive edge-lineage", "edge-negative dimmed"]);
  });
});

describe("任务节点展开态与连线", () => {
  const positive = edge(["p1", "out"], ["t1", "positive"]);
  const image = edge(["ref1", "out"], ["t1", "image:0"], { system: true });
  const trunk = edge(["t1", "result"], ["r1", "in"], { system: true });
  const edges = [positive, image, trunk];
  const withTask = (expanded: ReadonlySet<string>): CanvasEdgeInput => ({
    ...input(edges, { expanded }),
    board: { ...board(edges), nodes: [task("t1")] },
  });

  it("收起时只留主干输出连线，展开后内部连线恢复", () => {
    expect(canvasEdges(withTask(new Set())).map((e) => e.id)).toEqual(["t1:result->r1:in"]);
    expect(canvasEdges(withTask(new Set(["t1"]))).map((e) => e.id)).toEqual([
      "p1:out->t1:positive",
      "ref1:out->t1:image:0",
      "t1:result->r1:in",
    ]);
  });
});
