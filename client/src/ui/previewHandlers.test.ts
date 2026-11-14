// 预览弹窗的接线判定（#137）：初始状态、选中的层与列表的缺省值。
import { describe, expect, it } from "vitest";
import { alphaBadgeText, exportOneLabel, initialEditTarget, pickedLayerIndex, previewLayers, previewOutlines, previewTargets } from "./previewHandlers";

const target = { label: "x", edgeRef: { from: ["a", "b"] as never, to: ["c", "d"] as never }, rects: [[0, 0, 1, 1] as never], render: "highlight_overlay" as const, firstRegion: 0 };

describe("初始状态", () => {
  it("没有编辑目标：纯预览", () => {
    const state = initialEditTarget({});
    expect(state.editing).toBeNull();
    expect(state.regionMode).toBe("overlay");
    expect(state.rects).toEqual([]);
  });

  it("有编辑目标：带上它的区域", () => {
    const state = initialEditTarget({ edit: target });
    expect(state.editing?.label).toBe("x");
    expect(state.rects).toHaveLength(1);
  });

  it("坐标框的表达：记成 bbox", () => {
    const state = initialEditTarget({ edit: { ...target, render: "bbox_tag" } });
    expect(state.regionMode).toBe("bbox");
  });
});

describe("选中的层", () => {
  it("底图：没有层", () => {
    expect(pickedLayerIndex(0, 3)).toBeNull();
  });

  it("第几层：从 1 起（与 core 的 sourceLayer 同口径）", () => {
    expect(pickedLayerIndex(1, 3)).toBe(1);
    expect(pickedLayerIndex(2, 3)).toBe(2);
  });

  it("越界：没有层", () => {
    expect(pickedLayerIndex(9, 3)).toBeNull();
  });
});

describe("缺省值", () => {
  it("图层、目标与轮廓：没有就是空数组", () => {
    expect(previewLayers(undefined)).toEqual([]);
    expect(previewTargets(undefined)).toEqual([]);
    expect(previewOutlines(undefined)).toEqual([]);
  });

  it("文案", () => {
    expect(exportOneLabel).toBe("保存");
    expect(alphaBadgeText).toBe("透明");
  });
});