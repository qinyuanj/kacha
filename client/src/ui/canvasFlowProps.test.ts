// 画布固定配置：交给 <ReactFlow> 的取值与视图切换动画时长。
// @xyflow/react 用替身：这里只锁常量取值，不需要真实渲染。
import { describe, expect, it, vi } from "vitest";
import { canvasFlowProps, ZOOM_DURATION_MS } from "./canvasFlowProps";

vi.mock("@xyflow/react", () => ({ SelectionMode: { Partial: "partial", Full: "full" } }));

describe("画布固定配置", () => {
  it("视图切换动画 200ms", () => {
    expect(ZOOM_DURATION_MS).toBe(200);
  });

  // 期望值在这里手抄一份：拆分要求这份配置「逐字不变」，抄一份独立期望才能抓到顺手改动。
  it("取值逐字不变", () => {
    expect(canvasFlowProps).toEqual({
      selectionOnDrag: true,
      selectionMode: "partial",
      selectionKeyCode: null,
      multiSelectionKeyCode: "Shift",
      panOnDrag: [1, 2],
      panActivationKeyCode: "Space",
      zoomOnScroll: true,
      zoomOnPinch: true,
      zoomOnDoubleClick: false,
      deleteKeyCode: ["Delete", "Backspace"],
      disableKeyboardA11y: true,
    });
  });

  it("没有多出拆分前不存在的键", () => {
    expect(Object.keys(canvasFlowProps).sort()).toEqual(
      ["deleteKeyCode", "disableKeyboardA11y", "multiSelectionKeyCode", "panActivationKeyCode", "panOnDrag", "selectionKeyCode", "selectionMode", "selectionOnDrag", "zoomOnDoubleClick", "zoomOnPinch", "zoomOnScroll"].sort(),
    );
  });
});
