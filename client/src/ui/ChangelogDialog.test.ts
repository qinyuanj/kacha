// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as changelog from "../core/changelog";
import { ChangelogDialog } from "./ChangelogDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let previous: HTMLButtonElement;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let scroll: ReturnType<typeof vi.fn>;
// 产品版本只由桌面配置声明；测试读取它，避免另写一条版本线。
const currentVersion = /^\s*version:\s*["']([^"']+)["']/m.exec(readFileSync("../mygo.config.ts", "utf8"))![1];

beforeEach(() => {
  container = document.createElement("div");
  previous = document.createElement("button");
  document.body.append(previous, container);
  previous.focus();
  root = createRoot(container);
  onClose = vi.fn<() => void>();
  scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  previous.remove();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});
async function show(version = currentVersion) {
  await act(async () => root.render(createElement(ChangelogDialog, { currentVersion: version, onClose })));
}
function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  container.querySelector('[role="dialog"]')!.dispatchEvent(event);
  return event;
}

describe("更新说明弹窗", () => {
  it("加载产品说明，标出当前版本与注意事项，并定位到当前版本", async () => {
    await show();
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")).toBe("changelog-title");
    expect(container.textContent).toContain(currentVersion + "当前版本");
    expect(container.textContent).toContain("Windows 桌面客户端");
    expect(container.querySelector(".changelog-notice")?.textContent).toBe(changelog.NOTICE_PREFIX);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭");
  });
  it("只展示当前及更早版本，尚未发布版本不进入弹窗", async () => {
    vi.spyOn(changelog, "parseChangelog").mockReturnValue([
      { version: "1.6.0", groups: [{ title: "新增", items: [{ text: "未来功能", notice: false }] }] },
      { version: "1.5.0", groups: [{ title: "改进", items: [{ text: "当前说明", notice: false }] }] },
      { version: "1.4.0", groups: [{ title: "修复", items: [{ text: "旧版说明", notice: false }] }] },
    ]);
    await show("1.5.5");
    const headings = [...container.querySelectorAll("section.changelog-release h2")].map((h) => h.textContent);
    expect(headings).toEqual(["1.5.0", "1.4.0"]);
    expect(container.textContent).not.toContain("未来功能");
  });
  it("当前版本未收录时仍展示已有说明，不误标当前版本", async () => {
    await show("dev");
    expect(container.textContent).toContain("Windows 桌面客户端");
    expect(container.textContent).not.toContain("当前版本");
    expect(scroll).not.toHaveBeenCalled();
  });
  it("关闭按钮、Escape和点击背景都关闭；点击内容不关闭", async () => {
    await show();
    container.querySelector("h2")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    container.querySelector("button")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
    container.querySelector(".modal-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
  it("Tab在关闭按钮和内容之间循环，卸载后恢复先前焦点", async () => {
    await show();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container.querySelector(".changelog-releases"));
    press("Tab");
    expect(document.activeElement).toBe(container.querySelector("button"));
    expect(press("ArrowDown").defaultPrevented).toBe(false);
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(previous);
  });
  it("说明为空时明确显示空状态", async () => {
    vi.spyOn(changelog, "parseChangelog").mockReturnValue([]);
    await show();
    expect(container.textContent).toContain("暂无更新说明");
    expect(container.querySelector("section")).toBeNull();
  });
  it.each([new Error("说明格式错误"), "说明读取异常"])("解析失败时保留可关闭弹窗并显示原因：%s", async (error) => {
    vi.spyOn(changelog, "parseChangelog").mockImplementation(() => { throw error; });
    await show();
    expect(container.querySelector(".notice-warn")?.textContent).toContain(String(error instanceof Error ? error.message : error));
    expect(container.querySelector("section")).toBeNull();
    container.querySelector("button")!.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
