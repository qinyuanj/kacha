// @vitest-environment jsdom
// 画板包的界面流程（#137）：导出与导入的接线。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useBoardPack } from "./useBoardPack";
import type { Board } from "../core/board";

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

const board = { format_version: 2, title: "a", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} } as unknown as Board;

interface Harness {
  prepareExport(key: string): Promise<void>;
  importPack(): Promise<void>;
  dialog: unknown;
}

async function show(port: FakePort, boards: { flushAll: () => Promise<void>; getBoard: (k: string) => Board | null; boardFileName: (k: string) => string | null; openImportedBoard: (p: string) => Promise<void> }): Promise<Harness> {
  const harness: Harness = { prepareExport: async () => undefined, importPack: async () => undefined, dialog: null };
  const Probe = () => {
    const pack = useBoardPack("/~", boards, () => undefined);
    harness.prepareExport = pack.prepareExport;
    harness.importPack = pack.importPack;
    harness.dialog = pack.dialog;
    return null;
  };
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
  return harness;
}

const boardsStub = (patch: Partial<{ flushAll: () => Promise<void>; getBoard: (k: string) => Board | null; boardFileName: (k: string) => string | null; openImportedBoard: (p: string) => Promise<void> }> = {}) => ({
  flushAll: async () => undefined,
  getBoard: () => board,
  boardFileName: () => "a.ugcboard.json",
  openImportedBoard: async () => undefined,
  ...patch,
});

describe("画板包流程", () => {
  it("导出：算计划后进确认框", async () => {
    const port = createFakePort();
    port.pack.facts = async () => [];
    const harness = await show(port, boardsStub());
    await act(async () => void harness.prepareExport("k1"));
    expect(harness.dialog).toBeTruthy();
  });

  it("导出：没有画板时什么都不做", async () => {
    const port = createFakePort();
    const harness = await show(port, boardsStub({ getBoard: () => null }));
    await act(async () => void harness.prepareExport("k1"));
    expect(harness.dialog).toBeNull();
  });

  it("导入：没有选文件就什么都不做", async () => {
    const port = createFakePort();
    port.media.pickPackFile = async () => null;
    const harness = await show(port, boardsStub());
    await act(async () => void harness.importPack());
    expect(harness.dialog).toBeNull();
  });

  it("导入：成功给一句话提示（关掉对话框）", async () => {
    const port = createFakePort();
    port.media.pickPackFile = async () => new File(["x"], "包.ugcpack");
    const harness = await show(port, boardsStub());
    await act(async () => void harness.importPack());
    expect(harness.dialog).toBeNull();
  });

  it("导入：出错给失败提示", async () => {
    const port = createFakePort();
    port.media.pickPackFile = async () => {
      throw new Error("offline");
    };
    const harness = await show(port, boardsStub());
    await act(async () => void harness.importPack());
    expect(harness.dialog).toBeNull();
  });
});
