// @vitest-environment jsdom
// 画板包模态（#137）：导出确认、进度与导入结局。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { BoardPackDialog, type PackDialogState } from "./BoardPackDialog";

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

async function show(state: PackDialogState, props: Partial<Parameters<typeof BoardPackDialog>[0]> = {}): Promise<void> {
  const port = createFakePort();
  await act(async () =>
    dom.render(
      createElement(ShellProvider, {
        port,
        children: createElement(BoardPackDialog, { state, onExport: vi.fn(), onCancelProgress: vi.fn(), onClose: vi.fn(), ...props }),
      }),
    ),
  );
}

describe("画板包模态", () => {
  it("导出确认：给出打包内容与预估大小", async () => {
    await show({
      stage: "confirmExport",
      boardFile: "a.ugcboard.json",
      plan: { board: { format_version: 2, title: "a", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} }, taskDirs: ["/~/任务"], files: [], missing: [] },
      contents: { duplicates: {}, bytes: 1024, totalBytes: 2048 },
    });
    expect(container.textContent).toContain("1 个任务目录");
    expect(container.textContent).toContain("预估大小：1.0 KB");
    expect(container.textContent).toContain("省去 1.0 KB");
  });

  it("导出确认：有缺图时按钮变了说法", async () => {
    await show({
      stage: "confirmExport",
      boardFile: "a.ugcboard.json",
      plan: { board: { format_version: 2, title: "a", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} }, taskDirs: [], files: [], missing: [{ nodeId: "n1", path: "/~/a.png" }] },
      contents: { duplicates: {}, bytes: 1024, totalBytes: 2048 },
    });
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("导出"));
    expect(button?.textContent).toContain("仍然导出…");
    expect(container.textContent).toContain("/~/a.png");
  });

  it("进度条：没有总量时 max 为 1", async () => {
    await show({ stage: "progress", title: "正在导出" });
    expect(container.querySelector("progress")?.getAttribute("max")).toBe("1");
  });

  it("进度中点背景不关闭，只能取消", async () => {
    const onClose = vi.fn();
    await show({ stage: "progress", title: "正在导出" }, { onClose });
    await act(async () => (container.querySelector(".modal-backdrop") as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("进度：可以取消", async () => {
    const onCancelProgress = vi.fn();
    await show({ stage: "progress", title: "正在导出" }, { onCancelProgress });
    expect(container.textContent).toContain("正在导出");
    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "取消");
    await act(async () => cancel?.click());
    expect(onCancelProgress).toHaveBeenCalled();
  });

  it("导入结局：给出冲突清单", async () => {
    await show({ stage: "importDone", message: "部分导入", conflicts: ["a.ugcboard.json"], notice: "同名画板已跳过" });
    expect(container.textContent).toContain("a.ugcboard.json");
  });
});
