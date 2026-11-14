// @vitest-environment jsdom
// 预览的状态判定（#137）：勾选、单层、拖拽与区域改动。
import { describe, expect, it } from "vitest";
import { beginDrag, clearRects, endDrag, layerLabel, pointInStage, regionChange, removeSelected, startEditState, targetLabel, toggleChecked, toggleSolo } from "./previewState";
import type { RegionTarget } from "./PreviewDialog";

const target = (patch: Partial<RegionTarget> = {}): RegionTarget => ({
  label: "提示词",
  edgeRef: { from: ["t1", "out"] as never, to: ["m1", "in"] as never },
  rects: [],
  render: "highlight_overlay",
  firstRegion: 0,
  ...patch,
});

describe("区域编辑的初始状态", () => {
  it("有目标：带上它的区域", () => {
    const state = startEditState(target({ rects: [[0, 0, 1, 1]] }));
    expect(state.editing?.label).toBe("提示词");
    expect(state.rects).toHaveLength(1);
    expect(state.selected).toBeNull();
  });

  it("坐标框的表达：记成 bbox", () => {
    const state = startEditState(target({ render: "bbox_tag" }));
    expect(state.regionMode).toBe("bbox");
  });
});

describe("勾选与单层", () => {
  it("勾选：加进去，再点一次拿掉", () => {
    const once = toggleChecked(new Set<number>(), 0);
    expect(once.has(0)).toBe(true);
    expect(toggleChecked(once, 0).has(0)).toBe(false);
  });

  it("单层：点同一个就取消", () => {
    expect(toggleSolo(null, 1)).toBe(1);
    expect(toggleSolo(1, 1)).toBeNull();
    expect(toggleSolo(1, 2)).toBe(2);
  });
});

describe("拖拽", () => {
  it("在空白处按下：开始画新框", () => {
    const state = startEditState(target());
    const next = beginDrag(state, null, { x: 0.1, y: 0.1 });
    expect(next.selected).toBeNull();
    expect(next.drag).toBeTruthy();
  });

  it("松手：空白处画的框被加进去", () => {
    const state = startEditState(target());
    const next = beginDrag(state, null, { x: 0.1, y: 0.1 });
    const applied: number[][] = [];
    endDrag({ ...state, drag: next.drag }, { x: 0.4, y: 0.4 }, (rects) => applied.push(...rects.map((r) => [...r])));
    expect(applied).toHaveLength(1);
  });

  it("松手：没有拖动就不改", () => {
    const state = startEditState(target());
    const applied: number[][] = [];
    endDrag(state, { x: 0.4, y: 0.4 }, (rects) => applied.push(...rects.map((r) => [...r])));
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

  it("区域改动：没有框时清空区域", () => {
    const changed = regionChange(target().edgeRef, [], "overlay");
    expect(changed.region).toBeNull();
  });

  it("区域改动：高亮叠加", () => {
    const changed = regionChange(target().edgeRef, [[0, 0, 1, 1]], "overlay");
    expect(changed.region?.render).toBe("highlight_overlay");
  });

  it("区域改动：坐标框", () => {
    const changed = regionChange(target().edgeRef, [[0, 0, 1, 1]], "bbox");
    expect(changed.region?.render).toBe("bbox_tag");
    expect(changed.region?.coordinate_kind).toBe("bbox");
  });

  it("目标的标签：有区域时带上个数", () => {
    expect(targetLabel(target())).toBe("提示词");
    expect(targetLabel(target({ rects: [[0, 0, 1, 1]] }))).toContain("1 区域");
  });

  it("图层名：没有名字时按序号", () => {
    expect(layerLabel(undefined, 0)).toBe("图层1");
    expect(layerLabel("底", 0)).toBe("底");
  });

  it("清空区域", () => {
    expect(clearRects()).toEqual([]);
  });
});
