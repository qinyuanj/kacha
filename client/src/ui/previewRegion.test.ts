// @vitest-environment jsdom
// 放大预览弹窗的区域编辑判定（#137）：命中手柄、拖拽结果、区域表达与保存形状。
import { describe, expect, it } from "vitest";
import { MAX_REGIONS } from "../core/overlay";
import { dragHandleOf, overRegionLimit, regionModeOf, regionSetting, rectsAfterDrag, shownRects, startDrag } from "./previewRegion";

const RECT: [number, number, number, number] = [0.1, 0.1, 0.4, 0.4];

function element(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.firstElementChild as HTMLElement;
}

describe("区域编辑", () => {
  it("按下角柄：开始缩放", () => {
    const handle = dragHandleOf(element('<span data-rect-index="2" data-corner="se"></span>'));
    expect(handle).toEqual({ index: 2, corner: "se" });
    const drag = startDrag(handle, [RECT], { x: 0.5, y: 0.5 });
    expect(drag.kind).toBe("resize");
  });

  it("按下矩形本身：开始移动", () => {
    const handle = dragHandleOf(element('<span data-rect-index="1"></span>'));
    expect(handle).toEqual({ index: 1 });
    expect(startDrag(handle, [RECT], { x: 0.2, y: 0.2 }).kind).toBe("move");
  });

  it("按下空白：开始画新框", () => {
    expect(dragHandleOf(document.createElement("div"))).toBeNull();
    expect(startDrag(null, [RECT], { x: 0.2, y: 0.2 }).kind).toBe("draw");
  });

  it("画新框：太小的拖拽不落矩形", () => {
    const drag = startDrag(null, [], { x: 0.1, y: 0.1 });
    expect(rectsAfterDrag(drag, [], { x: 0.5, y: 0.5 })).toHaveLength(1);
    expect(rectsAfterDrag(drag, [], { x: 0.1001, y: 0.1001 })).toHaveLength(0);
  });

  it("移动：只动被拖的那个", () => {
    const drag = { kind: "move" as const, index: 0, start: { x: 0.1, y: 0.1 }, origin: RECT, current: { x: 0.1, y: 0.1 } };
    const next = rectsAfterDrag(drag, [RECT, [0.5, 0.5, 0.6, 0.6]], { x: 0.2, y: 0.2 });
    expect(next[0]).toEqual([0.2, 0.2, 0.5, 0.5]);
    expect(next[1]).toEqual([0.5, 0.5, 0.6, 0.6]);
  });

  it("拖拽中的显示：正在动的那个跟着指针", () => {
    const drag = { kind: "move" as const, index: 0, start: { x: 0.1, y: 0.1 }, origin: RECT, current: { x: 0.2, y: 0.2 } };
    expect(shownRects(drag, [RECT])[0]).toEqual([0.2, 0.2, 0.5, 0.5]);
  });

  it("画框中：显示里多一个正在画的框", () => {
    const drag = { kind: "draw" as const, start: { x: 0.1, y: 0.1 }, current: { x: 0.3, y: 0.4 } };
    expect(shownRects(drag, [])).toHaveLength(1);
  });

  it("区域表达：bbox_tag 按目标给的，否则高亮叠加", () => {
    expect(regionModeOf({ render: "bbox_tag" })).toBe("bbox");
    expect(regionModeOf({ render: "bbox_tag", coordinateKind: "point" })).toBe("point");
    expect(regionModeOf({ render: "highlight_overlay" })).toBe("overlay");
  });

  it("保存形状：没有区域是清空，overlay 不带坐标方式", () => {
    expect(regionSetting([], "overlay")).toBeNull();
    expect(regionSetting([RECT], "overlay")).toEqual({ rects: [RECT], render: "highlight_overlay" });
    expect(regionSetting([RECT], "point")).toEqual({ rects: [RECT], render: "bbox_tag", coordinate_kind: "point" });
  });

  it("区域数量超限", () => {
    expect(overRegionLimit(MAX_REGIONS)).toBe(false);
    expect(overRegionLimit(MAX_REGIONS + 1)).toBe(true);
  });
});
