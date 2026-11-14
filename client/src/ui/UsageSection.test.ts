// @vitest-environment jsdom
// 用量区块的可见行为（#137）：用量总数、未引用目录的摘要、清理按钮的禁用条件、清理完成说明。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Usage } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { UsageSection } from "./UsageSection";

// React 19 的 act() 要在测试环境里显式打开。
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

function usage(patch: Partial<Usage> = {}): Usage {
  return { total_bytes: 2048, boards_bytes: 1024, meta_bytes: 1024, last_access: 0, by_date: [], unreferenced: null, unreadable_board: null, limit_bytes: null, limit_level: null, ...patch };
}

async function show(port: FakePort): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(UsageSection) })));
}

/** 找到某个文字的按钮。 */
function buttonWithText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`没有找到按钮 ${text}`);
  return el as HTMLButtonElement;
}

describe("用量区块", () => {
  it("显示用量总数与上限", async () => {
    const port = createFakePort();
    port.usage.usage = async () => usage({ limit_bytes: 4096 });
    await show(port);
    expect(container.querySelector("[data-testid='usage-total']")?.textContent).toBe("2.0 KiB / 上限 4.0 KiB");
  });

  it("没有未引用目录：摘要说明没有，清理按钮置灰", async () => {
    const port = createFakePort();
    port.usage.usage = async () => usage();
    await show(port);
    expect(container.querySelector("[data-testid='usage-unreferenced-summary']")?.textContent).toBe("没有未引用任务目录");
    expect(buttonWithText("清理未引用任务目录").disabled).toBe(true);
  });

  it("有未引用目录：摘要给个数与体量，清理按钮可点", async () => {
    const port = createFakePort();
    port.usage.usage = async () => usage({ unreferenced: [{ dir: "2026-11-01/x", bytes: 1024, last_write: 0 }] });
    await show(port);
    expect(container.querySelector("[data-testid='usage-unreferenced-summary']")?.textContent).toBe("1 个未引用任务目录，共 1.0 KiB");
    expect(buttonWithText("清理未引用任务目录").disabled).toBe(false);
  });

  it("画板读不懂：显示提示并禁用清理（为避免误删）", async () => {
    const port = createFakePort();
    port.usage.usage = async () => usage({ unreferenced: [{ dir: "x", bytes: 1, last_write: 0 }], unreadable_board: "坏的画板" });
    await show(port);
    expect(container.querySelector("[data-testid='usage-unreadable']")?.textContent).toContain("画板读不懂（坏的画板）");
    expect(buttonWithText("清理未引用任务目录").disabled).toBe(true);
  });

  it("清理：先弹确认框，确认后调用清理并给出说明", async () => {
    const port = createFakePort();
    port.usage.usage = async () => usage({ unreferenced: [{ dir: "x", bytes: 1, last_write: 0 }] });
    let cleaned: string[] = [];
    port.usage.cleanupUnreferenced = async (dirs) => {
      cleaned = dirs;
      return { moved: [{ dir: "x", bytes: 1, last_write: 0 }], skipped: [] };
    };
    await show(port);
    await act(async () => buttonWithText("清理未引用任务目录").click());
    expect(container.textContent).toContain("清理未引用任务目录");
    await act(async () => buttonWithText("移入回收区").click());
    expect(cleaned).toEqual(["x"]);
    expect(container.textContent).toContain("已把 1 个任务目录移入回收区");
  });

  it("读用量失败：显示错误", async () => {
    const port = createFakePort();
    port.usage.usage = async () => {
      throw new Error("offline");
    };
    await show(port);
    expect(container.textContent).toContain("offline");
  });
});
