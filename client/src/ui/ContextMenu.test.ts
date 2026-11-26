// @vitest-environment jsdom
// 画板菜单的键盘契约（#267）：自动聚焦、方向键 / Home / End 跳过置灰项、回车 / 空格执行、Esc 返还焦点。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardAction, MenuItem } from "../core/contextMenu";
import { ContextMenu } from "./ContextMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: MenuItem[] = [
  { action: "newPrompt", label: "新建提示词", disabledReason: null, separatorBefore: false },
  { action: "newTask", label: "新建生成任务", disabledReason: null, separatorBefore: false },
  { action: "undo", label: "撤销", disabledReason: "没有可撤销的操作", separatorBefore: true },
  { action: "redo", label: "重做", disabledReason: null, separatorBefore: false },
];

let opener: HTMLButtonElement;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  opener = document.createElement("button");
  document.body.append(opener);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opener.focus();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
});

async function show(onPick = vi.fn(), onClose = vi.fn()): Promise<{ onPick: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  await act(async () => root.render(createElement(ContextMenu, { at: { x: 10, y: 20 }, items, onPick, onClose })));
  return { onPick, onClose };
}

function activeLabel(): string | null {
  return document.activeElement instanceof HTMLButtonElement ? document.activeElement.textContent : null;
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

describe("画板菜单键盘导航", () => {
  it("打开即聚焦首个可用项，方向键在可用项之间循环并跳过置灰项", async () => {
    await show();
    expect(activeLabel()).toBe("新建提示词");
    await press("ArrowDown");
    expect(activeLabel()).toBe("新建生成任务");
    await press("ArrowDown");
    expect(activeLabel()).toBe("重做");
    await press("ArrowDown");
    expect(activeLabel()).toBe("新建提示词");
    await press("ArrowUp");
    expect(activeLabel()).toBe("重做");
    await press("Home");
    expect(activeLabel()).toBe("新建提示词");
    await press("End");
    expect(activeLabel()).toBe("重做");
  });

  it("回车与空格执行当前可用项，关闭菜单并把焦点还给触发者", async () => {
    const first = await show();
    await press("Enter");
    expect(first.onPick).toHaveBeenCalledWith("newPrompt" satisfies BoardAction);
    expect(first.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);

    const second = await show();
    await press("ArrowDown");
    await press(" ");
    expect(second.onPick).toHaveBeenCalledWith("newTask" satisfies BoardAction);
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("Esc 只关闭菜单并返还焦点，不执行条目", async () => {
    const { onPick, onClose } = await show();
    await press("Escape");
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });
});
