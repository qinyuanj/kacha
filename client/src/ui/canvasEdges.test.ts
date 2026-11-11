// 画布连线数据的派生：id / 端点 / 选中 / 区域徽标 / 系统连线 / 谱系高亮与去强调，以及悬浮信息。
import { describe, expect, it } from "vitest";
import type { Board, BoardEdge } from "../core/board";
import { REGION_TEXT } from "./boardText";
import { canvasEdges, type CanvasEdgeInput } from "./canvasEdges";
import { edgeIdOf } from "./canvasPoint";

function board(edges: BoardEdge[]): Board {
  return { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges, extra: {} };
}

function edge(from: [string, string], to: [string, string], patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from, to, source_layer: null, region: null, system: false, extra: {}, ...patch };
}

function input(edges: BoardEdge[], patch: Partial<CanvasEdgeInput> = {}): CanvasEdgeInput {
  return { board: board(edges), selectedEdges: new Set(), selectedNodes: new Set(), lineageEdges: new Set(), dragging: false, ...patch };
}

describe("连线的基本字段", () => {
  it("id 与画板端点一一对应，端点 / 端口原样带过去；用户连线可删可选", () => {
    const e = edge(["p1", "out"], ["t1", "positive"]);
    const [out] = canvasEdges(input([e]));
    expect(out.id).toBe("p1:out->t1:positive");
    expect(out.id).toBe(edgeIdOf(e));
    expect([out.source, out.sourceHandle, out.target, out.targetHandle]).toEqual(["p1", "out", "t1", "positive"]);
    expect(out.selected).toBe(false);
    expect(out.deletable).toBe(true);
    expect(out.selectable).toBe(true);
    expect(out.label).toBeUndefined();
    expect(out.className).toBe("edge-positive");
  });

  it("系统连线不可删、不可选，按系统色显示且没有悬浮信息", () => {
    const [out] = canvasEdges(input([edge(["t1", "out"], ["res1", "in"], { system: true })]));
    expect(out.deletable).toBe(false);
    expect(out.selectable).toBe(false);
    expect(out.className).toBe("edge-system");
    expect(out.data).toEqual({ hover: [] });
  });

  it("顺序与画板连线一致", () => {
    const edges = canvasEdges(
      input([edge(["p1", "out"], ["t1", "positive"]), edge(["p2", "out"], ["t1", "negative"]), edge(["ref1", "out"], ["t1", "image:0"])]),
    );
    expect(edges.map((e) => e.id)).toEqual(["p1:out->t1:positive", "p2:out->t1:negative", "ref1:out->t1:image:0"]);
    expect(edges.map((e) => e.className)).toEqual(["edge-positive", "edge-negative", "edge-image"]);
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
    expect(out.data).toEqual({
      hover: [
        { label: "区域", text: "2 个修改区域" },
        { label: "来源", text: "合成图" },
      ],
    });
  });

  it("接的是结果图层时悬浮信息点明图层序号；没有区域时不给徽标", () => {
    const [out] = canvasEdges(input([edge(["res1", "out"], ["t1", "image:0"], { source_layer: 2, region: { rects: [], render: "highlight_overlay" } })]));
    expect(out.label).toBeUndefined();
    expect(out.data).toEqual({
      hover: [
        { label: "区域", text: "未框选" },
        { label: "来源", text: "图层 2" },
      ],
    });
  });

  it("系统图片线仍按一个区域显示徽标，同时保持不可删不可选且没有悬浮信息", () => {
    const e = edge(["ref1", "out"], ["t1", "image:0"], {
      system: true,
      region: { rects: [[0.1, 0.1, 0.2, 0.2]], render: "highlight_overlay" },
    });
    const [out] = canvasEdges(input([e]));
    expect(out.label).toBe(REGION_TEXT.edgeLabel(1));
    expect(out.data).toEqual({ hover: [] });
    expect(out.deletable).toBe(false);
    expect(out.selectable).toBe(false);
    expect(out.className).toBe("edge-system");
  });
});

describe("选中、谱系高亮与去强调", () => {
  const e = edge(["p1", "out"], ["t1", "positive"]);

  it("选中的连线按 edgeIdOf 对齐标出来", () => {
    const [out] = canvasEdges(input([e], { selectedEdges: new Set([edgeIdOf(e)]) }));
    expect(out.selected).toBe(true);
  });

  it("谱系上的连线加高亮类名，有选中时其余去强调", () => {
    const edges = canvasEdges(
      input([e, edge(["p2", "out"], ["t1", "negative"])], { selectedNodes: new Set(["p1"]), lineageEdges: new Set([e]) }),
    );
    expect(edges.map((x) => x.className)).toEqual(["edge-positive edge-lineage", "edge-negative dimmed"]);
  });

  it("拖线中所有连线都去强调", () => {
    const [out] = canvasEdges(input([e], { dragging: true }));
    expect(out.className).toBe("edge-positive dimmed");
  });

  it("空画板没有连线", () => {
    expect(canvasEdges(input([]))).toEqual([]);
  });
});
