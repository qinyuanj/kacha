// @vitest-environment jsdom
// 画板包的界面流程（#137）：导出进入确认、错误信息可见；接线结局由 shellPort 测试证明。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useBoardPack } from "./useBoardPack";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;
/** hook 最新的样子：断言读它，不必去 DOM 里找。 */
let latest: ReturnType<typeof useBoardPack> | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
  latest = null;
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

const board = { format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} } as never;

const boardsStub = () => ({
  flushAll: vi.fn(async () => undefined),
  getBoard: vi.fn<() => unknown>(() => board),
  boardFileName: vi.fn(() => "a.ugcboard.json"),
  openImportedBoard: vi.fn(async () => undefined),
});

async function show(port: FakePort, boards: ReturnType<typeof boardsStub>, toast: (message: string) => void = () => undefined) {
  const Probe = () => {
    latest = useBoardPack("/~", boards as never, toast);
    return null;
  };
  await act(async () => {
    dom.render(createElement(ShellProvider, { port, children: createElement(Probe) }));
  });
}

describe("画板包流程", () => {
  it("准备导出：进入确认阶段", async () => {
    const port = createFakePort();
    await show(port, boardsStub());
    await act(async () => void latest?.prepareExport("k1"));
    expect((latest?.dialog as { state?: { stage?: string } } | null)?.state?.stage).toBe("confirmExport");
  });

  it("导入抛错：错误信息可见", async () => {
    const port = createFakePort();
    port.media.pickPackFile = async () => {
      throw new Error("offline");
    };
    const toasts: string[] = [];
    await show(port, boardsStub(), (message) => toasts.push(message));
    await act(async () => void latest?.importPack());
    expect(toasts).toEqual(["导入画板包失败：offline"]);
  });

  it("没有打开的画板：导出不进入确认", async () => {
    const port = createFakePort();
    const boards = { ...boardsStub(), getBoard: vi.fn<() => unknown>(() => null) };
    await show(port, boards);
    await act(async () => void latest?.prepareExport("missing"));
    expect(latest?.dialog).toBeNull();
  });
});
