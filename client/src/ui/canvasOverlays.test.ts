// @vitest-environment jsdom
// 画布浮层：整理条、上下文菜单、放大预览弹窗、悬浮信息层与动作条——各自判空（没开 / 没有条目就不渲染）、
// 位置取自菜单状态、弹窗按 nonce 重挂、条目点击与关闭都接上回调。
// vitest 的 include 只收 *.test.ts，所以用 createElement 而不是 JSX；@xyflow/react 的 NodeToolbar 用替身，
// 预览弹窗用替身（它自己要画布上下文与图片信息，那是它自己的测试范围）。
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoard, type Board, type BoardEdge, type ResultNode, type TaskNode } from "../core/board";
import type { MenuItem } from "../core/contextMenu";
import { TIDY_TEXT } from "./boardText";
import { CanvasActionBar, CanvasOverlays, type CanvasActionBarProps, type CanvasOverlaysProps } from "./canvasOverlays";
import type { CanvasMenuState, CanvasPreviewState } from "./useCanvasOverlaysState";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xyflow/react", async () => {
  const { createElement: h } = await import("react");
  return {
    NodeToolbar: (props: { nodeId?: string | string[]; isVisible?: boolean; position?: string; children?: unknown }) =>
      h(
        "div",
        {
          "data-testid": "node-toolbar",
          "data-ids": Array.isArray(props.nodeId) ? props.nodeId.join(",") : String(props.nodeId ?? ""),
          "data-visible": String(props.isVisible),
          "data-position": props.position,
        },
        props.children as never,
      ),
    Position: { Left: "left", Right: "right", Top: "top" },
  };
});

// 预览弹窗替身：记下收到的 props 与挂载次数（nonce 作 key，换 nonce 应重新挂载）。
const dialog = vi.hoisted(() => ({
  mounts: 0,
  last: null as null | { req: { title: string }; toast: (message: string) => void; onClose: () => void },
}));

vi.mock("./PreviewDialog", async () => {
  const { createElement: h, useEffect } = await import("react");
  return {
    PreviewDialog: (props: { req: { title: string }; toast: (message: string) => void; onClose: () => void }) => {
      dialog.last = props;
      useEffect(() => {
        dialog.mounts += 1;
      }, []);
      return h("div", { "data-testid": "preview-dialog" }, props.req.title);
    },
  };
});

// ---- 夹具 ----

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dialog.mounts = 0;
  dialog.last = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const MENU: CanvasMenuState = { target: { kind: "pane" }, client: { x: 30, y: 40 }, at: { x: 60, y: 120 } };
const PREVIEW: CanvasPreviewState = { req: { title: "a.png", absPath: "/~/.data/a.png" }, nonce: 1 };
const MENU_ITEMS: MenuItem[] = [
  { action: "preview", label: "放大预览", disabledReason: null },
  { action: "delete", label: "删除", disabledReason: null, separatorBefore: true },
];
const NONE_SPEC = { tier: "2K", ratio: "1:1", width: null, height: null };

const task = (id: string): TaskNode => ({ id, type: "task", pos: [0, 0], size: [280, 260], extra: {}, model: "m", size_spec: NONE_SPEC, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null });

const result = (id: string, taskId: string): ResultNode => ({
  id, type: "result", pos: [800, 0], size: [240, 240], extra: {}, task_id: taskId + "-run", file: id + ".png", path: id + ".png", layer_count: 0,
  record: { model: "m", prompt: "", negative_prompt: "", size_spec: NONE_SPEC, submitted_at: "2026-09-16T09:15:00.000Z" },
});

const systemEdge = (taskId: string, resultId: string): BoardEdge => ({ from: [taskId, "result"], to: [resultId, "in"], source_layer: null, region: null, system: true, extra: {} });

/** 两次尝试：各是一个生成任务带一张结果，都没进阶段。 */
const twoAttempts = (): Board => ({ ...newBoard(), nodes: [task("t1"), result("r1", "t1"), task("t2"), result("r2", "t2")], edges: [systemEdge("t1", "r1"), systemEdge("t2", "r2")] });

const BAR_ITEMS: MenuItem[] = [
  { action: "preview", label: "放大预览", disabledReason: null },
  { action: "saveAs", label: "另存为…", disabledReason: null },
];

function overlays(overrides: Partial<CanvasOverlaysProps> = {}): CanvasOverlaysProps {
  return {
    menu: null,
    menuEntries: [],
    onPickMenu: vi.fn(),
    onCloseMenu: vi.fn(),
    preview: null,
    onClosePreview: vi.fn(),
    toast: vi.fn(),
    tidying: false,
    tidyMeasure: { measure: null, before: null },
    board: newBoard(),
    readOnly: false,
    apply: vi.fn(),
    onTidyDone: vi.fn(),
    hoverLayer: null,
    ...overrides,
  };
}

function actionBar(overrides: Partial<CanvasActionBarProps> = {}): CanvasActionBarProps {
  return {
    present: true,
    nodes: ["r1"],
    items: BAR_ITEMS,
    onPick: vi.fn(),
    onPointerEnter: vi.fn(),
    onPointerLeave: vi.fn(),
    ...overrides,
  };
}

async function show(ui: ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

const buttons = (selector = "button"): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(selector)];
const buttonByText = (text: string): HTMLButtonElement => buttons(".tidy-bar button").find((b) => b.textContent === text)!;

describe("CanvasOverlays", () => {
  it("什么都不开时只渲染空的浮层容器", async () => {
    await show(createElement(CanvasOverlays, overlays()));
    expect(container.querySelector(".tidy-bar")).toBeNull();
    expect(container.querySelector(".context-menu")).toBeNull();
    expect(container.querySelector('[data-testid="preview-dialog"]')).toBeNull();
    expect(container.querySelector(".hover-info")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("整理模式才出整理条，点「完成」退出", async () => {
    const props = overlays({ tidying: true });
    await show(createElement(CanvasOverlays, props));
    const bar = container.querySelector(".tidy-bar")!;
    expect(bar.getAttribute("aria-label")).toBe("整理模式");
    expect(bar.textContent).toContain(TIDY_TEXT.measuring);
    await act(async () => buttonByText(TIDY_TEXT.done).click());
    expect(props.onTidyDone).toHaveBeenCalledTimes(1);
  });

  it("上下文菜单落在右键处的窗口坐标上，点条目交给画布执行并关掉菜单", async () => {
    const props = overlays({ menu: MENU, menuEntries: MENU_ITEMS });
    await show(createElement(CanvasOverlays, props));
    const menu = container.querySelector<HTMLElement>(".context-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.style.left).toBe("30px");
    expect(menu.style.top).toBe("40px");
    expect(buttons(".context-menu button").map((b) => b.textContent)).toEqual(["放大预览", "删除"]);
    await act(async () => buttons(".context-menu button")[1].click());
    expect(props.onCloseMenu).toHaveBeenCalledTimes(1);
    expect(props.onPickMenu).toHaveBeenCalledWith("delete");
  });

  it("菜单开着但没有条目（系统连线、未知节点）时不出菜单", async () => {
    await show(createElement(CanvasOverlays, overlays({ menu: MENU, menuEntries: [] })));
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("预览弹窗按 nonce 重挂，关闭与提示都接上回调", async () => {
    const props = overlays({ preview: PREVIEW });
    await show(createElement(CanvasOverlays, props));
    expect(container.querySelector('[data-testid="preview-dialog"]')!.textContent).toBe("a.png");
    expect(dialog.mounts).toBe(1);
    expect(dialog.last!.toast).toBe(props.toast);
    expect(dialog.last!.onClose).toBe(props.onClosePreview);
    // 别的状态变化不动弹窗（key 没变就不重挂）。
    await act(async () => root.render(createElement(CanvasOverlays, { ...props, tidying: true })));
    expect(dialog.mounts).toBe(1);
    // 再打开同一个节点：nonce 变了，弹窗从头开始。
    await act(async () => root.render(createElement(CanvasOverlays, { ...props, preview: { ...PREVIEW, nonce: 2 } })));
    expect(dialog.mounts).toBe(2);
    await act(async () => root.render(createElement(CanvasOverlays, { ...props, preview: null })));
    expect(container.querySelector('[data-testid="preview-dialog"]')).toBeNull();
  });

  it("共享的悬浮信息层照原样渲染", async () => {
    const layer = createElement("div", { className: "hover-info" }, "透明通道");
    await show(createElement(CanvasOverlays, overlays({ hoverLayer: layer })));
    expect(container.querySelector(".hover-info")!.textContent).toBe("透明通道");
  });
});

describe("整理条上的「自动划分阶段」（#143）", () => {
  it("按钮上写这次会建几个阶段：按当前画板在渲染时现算", async () => {
    await show(createElement(CanvasOverlays, overlays({ tidying: true, board: twoAttempts() })));
    const button = buttonByText(TIDY_TEXT.autoStages(2));
    expect(button.disabled).toBe(false);
  });

  it("没有可以划成阶段的东西时置灰，title 说明原因", async () => {
    const props = overlays({ tidying: true, board: newBoard() });
    await show(createElement(CanvasOverlays, props));
    const button = buttonByText(TIDY_TEXT.autoStages(0));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(TIDY_TEXT.autoStagesEmpty);
    await act(async () => button.click());
    expect(props.apply).not.toHaveBeenCalled();
  });

  it("点击发一次自动划分阶段的画板变更（一次点击一步）", async () => {
    const props = overlays({ tidying: true, board: twoAttempts() });
    await show(createElement(CanvasOverlays, props));
    await act(async () => buttonByText(TIDY_TEXT.autoStages(2)).click());
    expect(props.apply).toHaveBeenCalledWith({ kind: "autoStages" });
  });

  it("只读 / 归档画板里不可点", async () => {
    const props = overlays({ tidying: true, board: twoAttempts(), readOnly: true });
    await show(createElement(CanvasOverlays, props));
    const button = buttonByText(TIDY_TEXT.autoStages(2));
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(props.apply).not.toHaveBeenCalled();
  });

  it("体量度量暂时算不出不影响按钮可用", async () => {
    await show(createElement(CanvasOverlays, overlays({ tidying: true, board: twoAttempts(), tidyMeasure: { measure: null, before: null } })));
    expect(buttonByText(TIDY_TEXT.autoStages(2)).disabled).toBe(false);
  });
});

describe("CanvasActionBar", () => {
  it("没有悬浮目标或没有条目时什么都不渲染", async () => {
    await show(createElement(CanvasActionBar, actionBar({ present: false })));
    expect(container.querySelector('[data-testid="node-toolbar"]')).toBeNull();
    await show(createElement(CanvasActionBar, actionBar({ items: [] })));
    expect(container.querySelector('[data-testid="node-toolbar"]')).toBeNull();
  });

  it("NodeToolbar 固定在节点上方，条目点击交给画布执行", async () => {
    const props = actionBar({ nodes: ["r1", "r2"] });
    await show(createElement(CanvasActionBar, props));
    const toolbar = container.querySelector<HTMLElement>('[data-testid="node-toolbar"]')!;
    expect(toolbar.getAttribute("data-ids")).toBe("r1,r2");
    expect(toolbar.getAttribute("data-visible")).toBe("true");
    expect(toolbar.getAttribute("data-position")).toBe("top");
    expect(container.querySelector(".action-bar")!.getAttribute("role")).toBe("toolbar");
    // 图标按钮的 aria-label 是条目文案，显示的是图标。
    const [preview, saveAs] = buttons(".action-bar button");
    expect(preview.getAttribute("aria-label")).toBe("放大预览");
    expect(saveAs.getAttribute("aria-label")).toBe("另存为…");
    expect(preview.textContent).toBe("⤢");
    await act(async () => preview.click());
    expect(props.onPick).toHaveBeenCalledWith("preview");
    await act(async () => saveAs.click());
    expect(props.onPick).toHaveBeenCalledWith("saveAs");
  });

  it("指针进出动作条：交给画布收起 / 保持动作条", async () => {
    const props = actionBar();
    await show(createElement(CanvasActionBar, props));
    const bar = container.querySelector(".action-bar")!;
    // React 的 pointerenter / pointerleave 由 pointerover / pointerout 合成。
    await act(async () => bar.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(props.onPointerEnter).toHaveBeenCalledTimes(1);
    await act(async () => bar.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
    expect(props.onPointerLeave).toHaveBeenCalledTimes(1);
  });
});
