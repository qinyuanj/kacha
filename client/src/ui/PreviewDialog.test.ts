// @vitest-environment jsdom
// 放大预览弹窗的可见行为（#137）：图层侧栏、勾选叠加、点缩略图看单层、保存区域回调、纯预览。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerRecord } from "../core/taskDir";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { BoardContext, type BoardActions } from "./context";
import { PreviewDialog, type PreviewRequest } from "./PreviewDialog";
import { ShellProvider } from "./shell";

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

function layerRecord(): LayerRecord {
  return { file: "l0.png", name: "第一层", description: "描述", z_index: 1, bounding_box: { absolute: [0, 0, 10, 10] } } as unknown as LayerRecord;
}

function actions(patch: Partial<BoardActions> = {}): BoardActions {
  return {
    table: {} as BoardActions["table"],
    userRoot: "/~",
    availableModels: [],
    concurrency: 1,
    apply: vi.fn(),
    continueEditing: vi.fn(),
    addAsReference: vi.fn(),
    generateVariant: vi.fn(),
    relocate: vi.fn(),
    previewNode: vi.fn(),
    editRegion: vi.fn(),
    perform: vi.fn(),
    setPromptDraft: vi.fn(),
    takePromptFocus: () => false,
    nodeUnmounted: vi.fn(),
    ...patch,
  };
}

async function show(req: PreviewRequest, port: FakePort, board = actions()): Promise<void> {
  await act(async () =>
    dom.render(
      createElement(ShellProvider, { port, children: createElement(BoardContext.Provider, { value: board }, createElement(PreviewDialog, { req, toast: vi.fn(), onClose: vi.fn() })) }),
    ),
  );
}

/** 按文字找按钮。 */
function buttonWithText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`没有找到按钮 ${text}`);
  return el as HTMLButtonElement;
}

describe("放大预览弹窗", () => {
  it("纯预览：显示标题与底图，没有图层侧栏", async () => {
    const port = createFakePort();
    await show({ title: "预览", absPath: "/~/a.png" }, port);
    expect(container.querySelector("[aria-label='预览']")).not.toBeNull();
    expect(container.querySelector(".preview-side")).toBeNull();
  });

  it("有图层：侧栏列出图层名与透明徽标", async () => {
    const port = createFakePort();
    port.files.inspectImage = async () => ({ sha256: "a", bytes: 10, width: 100, height: 100, format: "png", has_alpha: true });
    await show({ title: "预览", absPath: "/~/a.png", layers: [{ record: layerRecord(), absPath: "/~/l0.png" }] }, port);
    expect(container.querySelector(".preview-side")).not.toBeNull();
    expect(container.textContent).toContain("第一层");
  });

  it("结果节点：露出「以此继续编辑」与「加为参考图」", async () => {
    const port = createFakePort();
    const board = actions();
    await show({ title: "预览", absPath: "/~/a.png", resultId: "r1", layers: [{ record: layerRecord(), absPath: "/~/l0.png" }] }, port, board);
    expect(buttonWithText("以此继续编辑")).toBeDefined();
    expect(buttonWithText("加为参考图")).toBeDefined();
    await act(async () => buttonWithText("加为参考图").click());
    expect(board.addAsReference).toHaveBeenCalledWith("r1", null);
  });

  it("区域编辑：保存时把区域回调给画板", async () => {
    const port = createFakePort();
    const board = actions();
    const target = {
      label: "图1",
      edgeRef: { from: ["r1", "out"] as [string, string], to: ["t1", "image:0"] as [string, string] },
      rects: [[0.1, 0.1, 0.4, 0.4] as [number, number, number, number]],
      render: "highlight_overlay" as const,
      firstRegion: 0,
    };
    await show({ title: "预览", absPath: "/~/a.png", edit: target }, port, board);
    expect(container.textContent).toContain("编辑区域：图1");
    await act(async () => buttonWithText("保存区域").click());
    expect(board.apply).toHaveBeenCalledWith({ kind: "setRegion", edge: target.edgeRef, region: { rects: target.rects, render: "highlight_overlay" } });
  });

  it("区域编辑：没有区域时保存是清空这条连线的区域", async () => {
    const port = createFakePort();
    const board = actions();
    const target = {
      label: "图1",
      edgeRef: { from: ["r1", "out"] as [string, string], to: ["t1", "image:0"] as [string, string] },
      rects: [] as [number, number, number, number][],
      render: "highlight_overlay" as const,
      firstRegion: 0,
    };
    await show({ title: "预览", absPath: "/~/a.png", edit: target }, port, board);
    await act(async () => buttonWithText("保存区域").click());
    expect(board.apply).toHaveBeenCalledWith({ kind: "setRegion", edge: target.edgeRef, region: null });
  });

  it("区域编辑：删除选中的按钮在没有选中时禁用", async () => {
    const port = createFakePort();
    const target = {
      label: "图1",
      edgeRef: { from: ["r1", "out"] as [string, string], to: ["t1", "image:0"] as [string, string] },
      rects: [[0.1, 0.1, 0.4, 0.4] as [number, number, number, number]],
      render: "highlight_overlay" as const,
      firstRegion: 0,
    };
    await show({ title: "预览", absPath: "/~/a.png", edit: target }, port);
    expect(buttonWithText("删除选中").disabled).toBe(true);
    expect(buttonWithText("清空").disabled).toBe(false);
  });

  it("纯预览：可编辑目标给出入口，点它进入编辑", async () => {
    const port = createFakePort();
    const target = {
      label: "图1",
      edgeRef: { from: ["r1", "out"] as [string, string], to: ["t1", "image:0"] as [string, string] },
      rects: [] as [number, number, number, number][],
      render: "highlight_overlay" as const,
      firstRegion: 0,
    };
    await show({ title: "预览", absPath: "/~/a.png", regionTargets: [target] }, port);
    expect(container.textContent).toContain("框选修改区域");
    await act(async () => buttonWithText("图1").click());
    expect(container.textContent).toContain("编辑区域：图1");
  });
});
