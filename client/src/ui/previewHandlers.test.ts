// 预览弹窗的接线判定（#137）：图层选择与导出文案。
import { describe, expect, it } from "vitest";
import { alphaBadgeText, exportOneLabel, pickedLayerIndex } from "./previewHandlers";

describe("选中的层", () => {
  it("底图：没有层", () => {
    expect(pickedLayerIndex(0, 3)).toBeNull();
  });

  it("第几层：从 1 起（与 core 的 sourceLayer 同口径）", () => {
    expect(pickedLayerIndex(1, 3)).toBe(1);
    expect(pickedLayerIndex(2, 3)).toBe(2);
  });
});

describe("文案", () => {
  it("导出按钮与透明徽标", () => {
    expect(exportOneLabel).toBe("保存");
    expect(alphaBadgeText).toBe("透明");
  });
});
