// @vitest-environment jsdom
// 预览的状态判定（#137）：拖拽、坐标换算与删除选中区域。
import { describe, expect, it } from "vitest";
import { beginDrag, endDrag, pointInStage, removeSelected, startEditState } from "./previewState";
import type { RegionTarget } from "./PreviewDialog";

const target = (patch: Partial<RegionTarget> = {}): RegionTarget => ({
  label: "提示词",
  edgeRef: { from: ["t1", "out"] as never, to: ["m1", "in"] as never },
  rects: [],
  render: "highlight_overlay",
  firstRegion: 0,
  ...patch,
});

describe("拖拽", () => {
  it("从空白处开始画并松手：落下的是这次拖出的矩形", () => {
    const state = startEditState(target());
    const next = beginDrag(state, null, { x: 0.1, y: 0.1 });
    expect(next.selected).toBeNull();
    expect(next.drag.kind).toBe("draw");
    const applied: [number, number, number, number][] = [];
    endDrag({ ...state, drag: next.drag }, { x: 0.4, y: 0.4 }, (rects) => applied.push(...rects.map((r) => [...r] as [number, number, number, number])));
    expect(applied).toEqual([[0.1, 0.1, 0.4, 0.4]]);
  });

  it("松手：没有拖动就不改", () => {
    const state = startEditState(target());
    const applied: [number, number, number, number][] = [];
    endDrag(state, { x: 0.4, y: 0.4 }, (rects) => applied.push(...rects.map((r) => [...r] as [number, number, number, number])));
    expect(applied).toHaveLength(0);
  });
});

describe("坐标换算", () => {
  it("在舞台里：给 0 到 1 的坐标", () => {
    const p = pointInStage({ left: 100, top: 100, width: 200, height: 200 }, { clientX: 150, clientY: 150 });
    expect(p.x).toBeCloseTo(0.25);
    expect(p.y).toBeCloseTo(0.25);
  });

  it("超出舞台：夹到边界", () => {
    const p = pointInStage({ left: 100, top: 100, width: 200, height: 200 }, { clientX: 0, clientY: 999 });
    expect(p.x).toBe(0);
    expect(p.y).toBe(1);
  });
});

describe("其余判定", () => {
  it("删除选中的框", () => {
    const rects: [number, number, number, number][] = [
      [0, 0, 0.5, 0.5],
      [1, 1, 2, 2],
    ];
    expect(removeSelected(rects, 0)).toHaveLength(1);
    expect(removeSelected(rects, null)).toHaveLength(2);
  });
});
