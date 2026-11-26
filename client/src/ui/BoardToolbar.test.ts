// @vitest-environment jsdom
// 精简后画板工具栏的可见契约（#267）：只剩撤销 / 重做 / 运行，从撤销开始；
// 没有新建节点控件、没有组合模型下拉，也没有它们的禁用占位。运行守卫保持原样。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardToolbar } from "./BoardToolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function show(props: Partial<Parameters<typeof BoardToolbar>[0]> = {}): Promise<void> {
  await act(async () => root.render(createElement(BoardToolbar, props)));
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

function byLabel(label: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]');
  if (!el) throw new Error("没有找到按钮 " + label);
  return el;
}

function runButton(): HTMLButtonElement {
  const el = buttons().find((b) => (b.textContent ?? "").includes("运行"));
  if (!el) throw new Error("没有找到运行按钮");
  return el;
}

async function click(el: HTMLButtonElement): Promise<void> {
  await act(async () => el.click());
}

describe("精简后的画板工具栏", () => {
  it("只有撤销、重做、运行，从撤销开始，没有新建按钮或模型下拉", async () => {
    await show({ undoLabel: "移动 2 个节点", redoLabel: "新建提示词" });
    expect(buttons().map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toEqual(["撤销", "重做", "▶ 运行"]);
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("＋");
  });

  it("没有画板时只有这三个入口置灰，不留禁用占位", async () => {
    await show({ disabled: true, undoLabel: "移动 2 个节点", redoLabel: "新建提示词" });
    expect(buttons()).toHaveLength(3);
    for (const el of buttons()) expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector("select")).toBeNull();
  });

  it("撤销 / 重做按有无历史项置灰，点击只触发各自的回调", async () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    await show({ onUndo, onRedo, undoLabel: "移动 2 个节点", redoLabel: null });
    await click(byLabel("撤销"));
    await click(byLabel("重做"));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).not.toHaveBeenCalled();
    expect(byLabel("撤销").getAttribute("aria-disabled")).toBeNull();
    expect(byLabel("重做").getAttribute("aria-disabled")).toBe("true");
  });

  it("运行按钮照旧可点；生成不可用时只拦运行", async () => {
    const onRun = vi.fn();
    await show({ onRun, selectedCount: 2 });
    await click(runButton());
    expect(onRun).toHaveBeenCalledTimes(1);

    const blocked = vi.fn();
    await show({ onRun: blocked, generationUnavailable: true, undoLabel: "移动 2 个节点" });
    expect(runButton().getAttribute("aria-disabled")).toBe("true");
    await click(runButton());
    expect(blocked).not.toHaveBeenCalled();
    expect(byLabel("撤销").getAttribute("aria-disabled")).toBeNull();
  });
});
