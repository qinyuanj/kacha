// @vitest-environment jsdom
// 画布浮层：上下文菜单、放大预览弹窗与悬浮信息层——各自判空（没开就不渲染）、
// 位置取自菜单状态、弹窗按 nonce 重挂、条目点击与关闭都接上回调。
// vitest 的 include 只收 *.test.ts，所以用 createElement 而不是 JSX；预览弹窗用替身（它自己要画布上下文与图片信息）。
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../core/contextMenu";
import { createFakePort } from "../shell/testing/fakePort";
import { CanvasOverlays, type CanvasOverlaysProps } from "./canvasOverlays";
import { ShellProvider } from "./shell";
import type { CanvasMenuState, CanvasPreviewState } from "./useCanvasOverlaysState";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
/** 壳端口替身：这些浮层都不碰壳。 */
let port: ReturnType<typeof createFakePort>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dialog.mounts = 0;
  dialog.last = null;
  port = createFakePort();
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

function overlays(overrides: Partial<CanvasOverlaysProps> = {}): CanvasOverlaysProps {
  return {
    menu: null,
    menuEntries: [],
    onPickMenu: vi.fn(),
    onCloseMenu: vi.fn(),
    preview: null,
    onClosePreview: vi.fn(),
    toast: vi.fn(),
    hoverLayer: null,
    ...overrides,
  };
}

/** 同一棵树：换状态重渲染也走这里，根组件不变（否则整棵树会重挂，弹窗的挂载次数就变了）。 */
const tree = (ui: ReactElement): ReactElement => createElement(ShellProvider, { port, children: ui });

async function show(ui: ReactElement): Promise<void> {
  await act(async () => root.render(tree(ui)));
}

const buttons = (selector = "button"): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(selector)];

describe("CanvasOverlays", () => {
  it("什么都不开时只渲染空的浮层容器", async () => {
    await show(createElement(CanvasOverlays, overlays()));
    expect(container.querySelector(".context-menu")).toBeNull();
    expect(container.querySelector('[data-testid="preview-dialog"]')).toBeNull();
    expect(container.querySelector(".hover-info")).toBeNull();
    expect(container.textContent).toBe("");
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
    await act(async () => root.render(tree(createElement(CanvasOverlays, { ...props, toast: vi.fn() }))));
    expect(dialog.mounts).toBe(1);
    // 再打开同一个节点：nonce 变了，弹窗从头开始。
    await act(async () => root.render(tree(createElement(CanvasOverlays, { ...props, preview: { ...PREVIEW, nonce: 2 } }))));
    expect(dialog.mounts).toBe(2);
    await act(async () => root.render(tree(createElement(CanvasOverlays, { ...props, preview: null }))));
    expect(container.querySelector('[data-testid="preview-dialog"]')).toBeNull();
  });

});
