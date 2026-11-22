// @vitest-environment jsdom
// 「运行」二次确认的可见行为（#218 收尾）：初始勾选、勾选切换、展开发送文本、确认回传、遮罩取消、两种范围标题。
// 只断言用户看得到的东西：勾选框状态、按钮文案、弹窗里的文本与回调参数。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendPlan } from "../core/sendPlan";
import type { ConfirmItem } from "../core/submission";
import type { UnrunnableReason } from "../core/taskView";
import { RunConfirmDialog } from "./RunConfirmDialog";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;
let onConfirm = vi.fn<(taskIds: string[]) => void>();
let onCancel = vi.fn<() => void>();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
  onConfirm = vi.fn<(taskIds: string[]) => void>();
  onCancel = vi.fn<() => void>();
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

/** 发送计划：只有发送文本与参考图张数参与二次确认的展示。 */
function send(text: string, referenceCount = 0): SendPlan {
  return { text, nativeNegativePrompt: null, workflow: "image_edit", negativeInlined: false, referenceCount, referenceProblems: { issues: [], warnings: [], unreferenced: [] } };
}

const blockedReason: UnrunnableReason = { kind: "imageMissing", category: "error", text: "图1 图片缺失：r1.png" };

/** 三项：a 可运行、b 标红、c 可运行且带两张参考图。 */
function confirmItems(): ConfirmItem[] {
  return [
    { taskId: "a", modelName: "模型A", firstLine: "首行A", send: send("完整发送文本 A"), reasons: [], warnings: [] },
    // 标红项的真实形态：模型不在能力表内（没有发送计划）、提示词首行为空。
    { taskId: "b", modelName: "模型B", firstLine: "", send: null, reasons: [blockedReason], warnings: [] },
    { taskId: "c", modelName: "模型C", firstLine: "首行C", send: send("完整发送文本 C", 2), reasons: [], warnings: [] },
  ];
}

async function show(scope: "selection" | "board" = "selection", items = confirmItems()): Promise<void> {
  await act(async () => dom.render(createElement(RunConfirmDialog, { items, scope, onConfirm, onCancel })));
}

function checkboxes(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error("没有找到按钮：" + text);
  return button;
}

describe("运行二次确认", () => {
  it("初始只勾选能运行的项：标红项不勾选，也不能勾", async () => {
    await show();
    expect(checkboxes().map((box) => box.checked)).toEqual([true, false, true]);
    expect(checkboxes().map((box) => box.disabled)).toEqual([false, true, false]);
  });

  it("点一行切换勾选，确认回传的编号跟着变", async () => {
    await show();
    await act(async () => checkboxes()[0].click());

    expect(checkboxes()[0].checked).toBe(false);
    await act(async () => buttonWithText("运行 1 个任务").click());
    expect(onConfirm).toHaveBeenCalledWith(["c"]);
  });

  it("展开后出现完整发送文本，收起后消失", async () => {
    await show();
    expect(container.textContent).not.toContain("完整发送文本 A");

    await act(async () => buttonWithText("展开完整发送文本").click());
    expect(container.textContent).toContain("完整发送文本 A");

    await act(async () => buttonWithText("收起发送文本").click());
    expect(container.textContent).not.toContain("完整发送文本 A");
  });

  it("确认回传的只有勾选过的编号，标红项不在其中", async () => {
    await show();
    await act(async () => buttonWithText("运行 2 个任务").click());
    expect(onConfirm).toHaveBeenCalledWith(["a", "c"]);
  });

  it("点遮罩取消；点弹窗内部不取消", async () => {
    await show();
    const dialog = container.querySelector(".modal");
    if (!dialog) throw new Error("没有弹窗");

    await act(async () => void dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onCancel).not.toHaveBeenCalled();

    const backdrop = container.querySelector(".modal-backdrop");
    if (!backdrop) throw new Error("没有遮罩");
    await act(async () => void backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("标题按范围变：选中子图 / 整个画板", async () => {
    await show("selection");
    expect(container.querySelector(".modal-head")?.textContent).toContain("选中子图");

    await show("board");
    expect(container.querySelector(".modal-head")?.textContent).toContain("整个画板");
  });
});
