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

const header = (patch: Partial<Parameters<typeof PreviewHeader>[0]> = {}) => ({
  title: "a",
  editing: null,
  regionMode: "overlay" as const,
  onRegionMode: vi.fn(),
  solo: null,
  showOutlines: false,
  onShowOutlines: vi.fn(),
  outlineCount: 0,
  onClose: vi.fn(),
  ...patch,
});

describe("弹窗头", () => {
  it("编辑中：给出编辑标记与区域表达", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, header({ editing: target({ coordinateAvailable: true }), regionMode: "bbox" }))));
    expect(container.textContent).toContain("编辑区域：提示词");
    expect(container.querySelector("[aria-label='区域表达']")).not.toBeNull();
  });

  it("编辑中但坐标不可用：没有区域表达下拉", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, header({ editing: target() }))));
    expect(container.textContent).toContain("编辑区域");
    expect(container.querySelector("[aria-label='区域表达']")).toBeNull();
  });

  it("单层：给出层号", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, header({ solo: 0 }))));
    expect(container.textContent).toContain("单层：图层1");
  });

  it("有区域轮廓：给出开关", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, header({ outlineCount: 3 }))));
    expect(container.textContent).toContain("区域轮廓");
  });

  it("编辑中：没有轮廓开关", async () => {
    await act(async () => dom.render(createElement(PreviewHeader, header({ editing: target(), outlineCount: 3 }))));
    expect(container.textContent).not.toContain("区域轮廓");
  });

  it("区域表达：切换时调 onRegionMode", async () => {
    const onRegionMode = vi.fn();
    await act(async () => dom.render(createElement(PreviewHeader, header({ editing: target({ coordinateAvailable: true }), onRegionMode }))));
    const select = container.querySelector("[aria-label='区域表达']") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "bbox");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onRegionMode).toHaveBeenCalledWith("bbox");
  });

  it("关闭按钮：调 onClose", async () => {
    const onClose = vi.fn();
    await act(async () => dom.render(createElement(PreviewHeader, header({ onClose }))));
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "关闭")?.click());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("弹窗尾", () => {
  const footer = (patch: Partial<Parameters<typeof PreviewFooter>[0]> = {}) => ({
    editing: null,
    targets: [],
    rects: [],
    selected: null,
    regionMode: "overlay" as const,
    first: 0,
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    onStartEdit: vi.fn(),
    ...patch,
  });

  it("纯预览：没有目标时只有关闭", async () => {
    await act(async () => dom.render(createElement(PreviewFooter, footer())));
    expect(container.textContent).not.toContain("框选修改区域");
    expect(container.textContent).toContain("关闭");
  });

  it("纯预览：给出可编辑目标的入口", async () => {
    await act(async () => dom.render(createElement(PreviewFooter, footer({ targets: [target({ rects: [[0, 0, 1, 1]] })] }))));
    expect(container.textContent).toContain("框选修改区域");
    expect(container.textContent).toContain("1 区域");
  });

  it("编辑中：给出区域操作", async () => {
    const onRemove = vi.fn();
    await act(async () => dom.render(createElement(PreviewFooter, footer({ editing: target(), rects: [[0, 0, 1, 1]], selected: 0, onRemove }))));
    expect(container.textContent).toContain("保存区域");
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "删除选中")?.click());
    expect(onRemove).toHaveBeenCalled();
  });

  it("编辑中：没有框时不能清空", async () => {
    await act(async () => dom.render(createElement(PreviewFooter, footer({ editing: target() }))));
    const clear = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "清空");
    expect(clear?.disabled).toBe(true);
  });

});
