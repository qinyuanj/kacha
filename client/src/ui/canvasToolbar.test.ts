// @vitest-environment jsdom
// 画布工具栏的接线契约（#267）：portal 进页面槽位、只给撤销 / 重做 / 运行；
// 归档画板不渲染新增控件，生成能力开关只影响运行按钮。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { CanvasToolbar, type CanvasToolbarProps } from "./canvasToolbar";
import { ShellProvider } from "./shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let slot: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  slot = document.createElement("div");
  container.append(slot);
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function show(port: FakePort, patch: Partial<CanvasToolbarProps> = {}): Promise<void> {
  const props: CanvasToolbarProps = { toolbarSlot: slot, readOnly: false, undoLabel: null, redoLabel: null, selectedCount: 0, onUndo: vi.fn(), onRedo: vi.fn(), onRun: vi.fn(), ...patch };
  await act(async () => root.render(createElement(ShellProvider, { port, children: createElement(CanvasToolbar, props) })));
}

function buttons(): HTMLButtonElement[] {
  return [...slot.querySelectorAll("button")];
}

function byLabel(label: string): HTMLButtonElement {
  const el = slot.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]');
  if (!el) throw new Error("没有找到按钮 " + label);
  return el;
}

function runButton(): HTMLButtonElement {
  const el = buttons().find((b) => (b.textContent ?? "").includes("运行"));
  if (!el) throw new Error("没有找到运行按钮");
  return el;
}

describe("画布工具栏接线", () => {
  it("portal 进槽位后只有撤销 / 重做 / 运行，没有模型下拉", async () => {
    await show(createFakePort(), { undoLabel: "移动 2 个节点", redoLabel: "新建提示词" });
    expect(slot.querySelector('[role="toolbar"][aria-label="画板工具栏"]')).not.toBeNull();
    expect(buttons().map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toEqual(["撤销", "重做", "▶ 运行"]);
    expect(slot.querySelector("select")).toBeNull();
  });

  it("没有槽位时不渲染工具栏", async () => {
    await show(createFakePort(), { toolbarSlot: null });
    expect(container.querySelector('[aria-label="画板工具栏"]')).toBeNull();
    expect(slot.childElementCount).toBe(0);
  });

  it("归档画板也没有新增控件或禁用占位", async () => {
    await show(createFakePort(), { readOnly: true, undoLabel: "移动 2 个节点", redoLabel: "新建提示词" });
    expect(buttons()).toHaveLength(3);
    for (const el of buttons()) expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(slot.querySelector("select")).toBeNull();
  });

  it("生成不可用时只置灰运行，撤销 / 重做仍可用", async () => {
    const port = createFakePort();
    port.features.generation = false;
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    await show(port, { onUndo, onRedo, onRun: vi.fn(), undoLabel: "移动 2 个节点", redoLabel: "新建提示词" });
    expect(runButton().getAttribute("aria-disabled")).toBe("true");
    expect(byLabel("撤销").getAttribute("aria-disabled")).toBeNull();
    expect(byLabel("重做").getAttribute("aria-disabled")).toBeNull();
    await act(async () => byLabel("撤销").click());
    await act(async () => byLabel("重做").click());
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });
});
