// @vitest-environment jsdom
// 画板工具栏的可见行为（#137）：置灰时的文案、撤销 / 重做的可用性、运行按钮的「选中」后缀、
// 生成与整理尚不可用时的标记与置灰。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { BoardToolbar } from "./BoardToolbar";

// React 19 的 act() 要在测试环境里显式打开。
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

async function show(props: Parameters<typeof BoardToolbar>[0]): Promise<void> {
  await act(async () => root.render(createElement(BoardToolbar, props)));
}

/** 按 aria-label 找按钮。 */
function buttonOf(label: string): HTMLButtonElement {
  const el = container.querySelector(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`没有找到按钮 ${label}`);
  return el as HTMLButtonElement;
}

/** 按文字找按钮。 */
function buttonWithText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`没有找到按钮 ${text}`);
  return el as HTMLButtonElement;
}

describe("画板工具栏", () => {
  it("没有画板：所有入口置灰", async () => {
    await show({ disabled: true });
    for (const el of container.querySelectorAll("button")) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("有画板：入口可点，点击触发各自的回调", async () => {
    const onNewPrompt = vi.fn();
    const onAddReferences = vi.fn();
    const onNewTask = vi.fn();
    const onRun = vi.fn();
    await show({ onNewPrompt, onAddReferences, onNewTask, onRun });
    await act(async () => buttonWithText("＋ 提示词").click());
    await act(async () => buttonWithText("＋ 参考图").click());
    await act(async () => buttonWithText("＋ 生成任务").click());
    await act(async () => buttonWithText("▶ 运行").click());
    expect(onNewPrompt).toHaveBeenCalled();
    expect(onAddReferences).toHaveBeenCalled();
    expect(onNewTask).toHaveBeenCalled();
    expect(onRun).toHaveBeenCalled();
  });

  it("撤销 / 重做：没有可撤销 / 重做的操作时置灰，有了才可点", async () => {
    const onUndo = vi.fn();
    await show({ onUndo });
    expect(buttonOf("撤销").getAttribute("aria-disabled")).toBe("true");
    await show({ onUndo, undoLabel: "新建提示词" });
    expect(buttonOf("撤销").getAttribute("aria-disabled")).toBeNull();
    await act(async () => buttonOf("撤销").click());
    expect(onUndo).toHaveBeenCalled();
  });

  it("运行：有选中时按钮写「运行选中」", async () => {
    await show({ selectedCount: 0 });
    expect(buttonWithText("▶ 运行").textContent).toBe("▶ 运行");
    await show({ selectedCount: 3 });
    expect(buttonWithText("▶ 运行").textContent).toBe("▶ 运行选中");
  });

  it("生成尚不可用：新建任务与运行都标「尚不可用」并置灰", async () => {
    const onRun = vi.fn();
    await show({ generationUnavailable: true, onRun });
    const run = buttonWithText("▶ 运行");
    expect(run.textContent).toContain("（" + UNAVAILABLE_TEXT + "）");
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(buttonWithText("＋ 生成任务").getAttribute("aria-disabled")).toBe("true");
    await act(async () => run.click());
    expect(onRun).not.toHaveBeenCalled();
  });

  it("整理：不可用时标「尚不可用」并置灰；在整理模式时按钮按下", async () => {
    await show({ tidyUnavailable: true });
    const tidy = buttonWithText("整理");
    expect(tidy.textContent).toBe("整理（" + UNAVAILABLE_TEXT + "）");
    expect(tidy.getAttribute("aria-disabled")).toBe("true");
    await show({ tidying: true });
    expect(buttonWithText("整理").getAttribute("aria-pressed")).toBe("true");
  });
});
