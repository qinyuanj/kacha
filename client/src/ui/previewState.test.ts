// @vitest-environment jsdom
// 放大预览弹窗的状态（#137）：编辑态、拖拽、勾选与保存形状。
import { describe, expect, it } from "vitest";
import { beginDrag, clearRects, endDrag, pointInStage, removeSelected, startEditState, targetLabel, toggleChecked, toggleSolo } from "./previewState";

const target = (patch = {}) => ({
  label: "图1",
  edgeRef: { from: ["r1", "out"] as [string, string], to: ["t1", "image:0"] as [string, string] },
  rects: [[0.1, 0.1, 0.4, 0.4] as [number, number, number, number]],
  render: "highlight_overlay" as const,
  firstRegion: 0,
  ...patch,
});

describe("编辑态", () => {
  it("打开即编辑：区域、表达方式与选中态", () => {
    const state = startEditState(target());
    expect(state.editing?.label).toBe("图1");
    expect(state.regionMode).toBe("overlay");
    expect(state.rects).toHaveLength(1);
    expect(state.selected).toBeNull();
  });

  it("bbox_tag 的目标：表达方式跟着坐标方式", () => {
    expect(startEditState(target({ render: "bbox_tag" } as never)).regionMode).toBe("bbox");
    expect(startEditState(target({ render: "bbox_tag", coordinateKind: "point" } as never)).regionMode).toBe("point");
  });
});

describe("拖拽", () => {
  it("按下空白：画新框", () => {
    const state = startEditState(target());
    const { selected, drag } = beginDrag(state, null, { x: 0.5, y: 0.5 });
    expect(selected).toBeNull();
    expect(drag.kind).toBe("draw");
  });

  it("按下矩形：动那个矩形", () => {
    const state = startEditState(target());
    const el = document.createElement("span");
    el.setAttribute("data-rect-index", "0");
    const { selected, drag } = beginDrag(state, el, { x: 0.5, y: 0.5 });
    expect(selected).toBe(0);
    expect(drag.kind).toBe("move");
  });

  it("松手：画出足够大的框才落矩形", () => {
    const state = startEditState(target({ rects: [] } as never));
    state.drag = { kind: "draw", start: { x: 0.1, y: 0.1 }, current: { x: 0.1, y: 0.1 } };
    const applied: number[] = [];
    endDrag(state, { x: 0.5, y: 0.5 }, (next) => applied.push(next.length));
    expect(applied).toEqual([1]);
  });

  it("松手：太小的框不落", () => {
    const state = startEditState(target({ rects: [] } as never));
    state.drag = { kind: "draw", start: { x: 0.1, y: 0.1 }, current: { x: 0.1, y: 0.1 } };
    const applied: number[] = [];
    endDrag(state, { x: 0.1001, y: 0.1001 }, (next) => applied.push(next.length));
    expect(applied).toEqual([0]);
  });
});

describe("指针位置", () => {
  it("相对底图的归一化坐标，钳在 0–1", () => {
    expect(pointInStage({ left: 0, top: 0, width: 100, height: 100 }, { clientX: 50, clientY: 25 })).toEqual({ x: 0.5, y: 0.25 });
    expect(pointInStage({ left: 0, top: 0, width: 100, height: 100 }, { clientX: 500, clientY: 500 })).toEqual({ x: 1, y: 1 });
  });
});

describe("图层与区域", () => {
  it("勾选：点一下加上，再点一下去掉", () => {
    const once = toggleChecked(new Set(), 0);
    expect(once.has(0)).toBe(true);
    expect(toggleChecked(once, 0).has(0)).toBe(false);
  });

  it("单层：点同一张再点取消", () => {
    expect(toggleSolo(null, 1)).toBe(1);
    expect(toggleSolo(1, 1)).toBeNull();
  });

  it("删除选中的区域", () => {
    const rects: [number, number, number, number][] = [[0, 0, 1, 1], [0, 0, 1, 1]];
    expect(removeSelected(rects, 0)).toHaveLength(1);
    expect(removeSelected(rects, null)).toHaveLength(2);
  });

  it("清空区域", () => {
    expect(clearRects()).toEqual([]);
  });

  it("可编辑目标的入口文字：有区域时带上个数", () => {
    expect(targetLabel(target())).toBe("图1（1 区域）");
    expect(targetLabel(target({ rects: [] } as never))).toBe("图1");
  });
});
