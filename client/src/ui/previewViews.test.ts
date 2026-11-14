// @vitest-environment jsdom
// 预览弹窗的头与尾（#137）：编辑状态、区域表达、单层标记与区域轮廓开关。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewFooter, PreviewHeader } from "./previewViews";
import type { RegionTarget } from "./PreviewDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

const target = (patch: Partial<RegionTarget> = {}): RegionTarget => ({
  label: "提示词",
  edgeRef: { from: ["t1", "out"] as never, to: ["m1", "in"] as never },
  rects: [],
  render: "highlight_overlay",
  firstRegion: 0,
  ...patch,
});

describe("弹窗头", () => {
  it("纯预览：没有编辑标记", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, { title: "a", editing: null, regionMode: "overlay", onRegionMode: vi.fn(), solo: null, showOutlines: false, onShowOutlines: vi.fn(), outlineCount: 0, onClose: vi.fn() })));
    expect(container.textContent).toContain("a");
    expect(container.textContent).not.toContain("编辑区域");
  });

  it("编辑中：给出编辑标记与区域表达", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, { title: "a", editing: target({ coordinateAvailable: true }), regionMode: "bbox", onRegionMode: vi.fn(), solo: null, showOutlines: false, onShowOutlines: vi.fn(), outlineCount: 0, onClose: vi.fn() })));
    expect(container.textContent).toContain("编辑区域：提示词");
    expect(container.querySelector("[aria-label='区域表达']")).not.toBeNull();
  });

  it("单层：给出层号", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, { title: "a", editing: null, regionMode: "overlay", onRegionMode: vi.fn(), solo: 0, showOutlines: false, onShowOutlines: vi.fn(), outlineCount: 0, onClose: vi.fn() })));
    expect(container.textContent).toContain("单层：图层1");
  });

  it("有区域轮廓：给出开关", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, { title: "a", editing: null, regionMode: "overlay", onRegionMode: vi.fn(), solo: null, showOutlines: false, onShowOutlines: vi.fn(), outlineCount: 3, onClose: vi.fn() })));
    expect(container.textContent).toContain("区域轮廓");
  });

  it("关闭按钮：调 onClose", async () => {
    const onClose = vi.fn();
    await act(async () => dom.render(createElement(PreviewHeader, { title: "a", editing: null, regionMode: "overlay", onRegionMode: vi.fn(), solo: null, showOutlines: false, onShowOutlines: vi.fn(), outlineCount: 0, onClose })));
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "关闭")?.click());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("弹窗尾", () => {
  it("纯预览：给出可编辑目标的入口", async () => {
    await act(async () => dom.render(createElement(PreviewFooter, { editing: null, targets: [target({ rects: [[0, 0, 1, 1]] })], rects: [], selected: null, regionMode: "overlay", first: 0, onRemove: vi.fn(), onClear: vi.fn(), onSave: vi.fn(), onClose: vi.fn(), onStartEdit: vi.fn() })));
    expect(container.textContent).toContain("框选修改区域");
    expect(container.textContent).toContain("1 区域");
  });

  it("编辑中：给出区域操作", async () => {
    const onRemove = vi.fn();
    await act(async () => dom.render(createElement(PreviewFooter, { editing: target(), targets: [], rects: [[0, 0, 1, 1]], selected: 0, regionMode: "overlay", first: 0, onRemove, onClear: vi.fn(), onSave: vi.fn(), onClose: vi.fn(), onStartEdit: vi.fn() })));
    expect(container.textContent).toContain("保存区域");
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "删除选中")?.click());
    expect(onRemove).toHaveBeenCalled();
  });

  it("编辑中：没选中时不能删", async () => {
    await act(async () => dom.render(createElement(PreviewFooter, { editing: target(), targets: [], rects: [], selected: null, regionMode: "overlay", first: 0, onRemove: vi.fn(), onClear: vi.fn(), onSave: vi.fn(), onClose: vi.fn(), onStartEdit: vi.fn() })));
    const remove = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "删除选中");
    expect(remove?.disabled).toBe(true);
  });

  it("编辑中：没有框时不能清空", async () => {
    await act(async () => dom.render(createElement(PreviewFooter, { editing: target(), targets: [], rects: [], selected: null, regionMode: "overlay", first: 0, onRemove: vi.fn(), onClear: vi.fn(), onSave: vi.fn(), onClose: vi.fn(), onStartEdit: vi.fn() })));
    const clear = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "清空");
    expect(clear?.disabled).toBe(true);
  });
});
