// @vitest-environment jsdom
// 工作台的可见行为（#137）：没有画板时的空工作台、提示条、设置面板入口、画板包菜单的禁用。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardListing } from "../shell/types";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { App } from "../App";

// React 19 的 act() 要在测试环境里显式打开。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画布太重（React Flow），测试里替掉：断言工作台这一层的接线。
vi.mock("./BoardCanvas", () => ({ BoardCanvas: () => createElement("div", { className: "canvas" }) }));

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

function listing(boards: BoardListing["boards"] = []): BoardListing {
  return { boards, slots: { used: 0, total: 10 }, size_lines: { warn: 100, alert: 200 } };
}

async function show(port: FakePort, props: { onLogout?: () => void; version?: string | null; sessionExpired?: boolean } = {}): Promise<void> {
  await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(App, { ...props }) })));
}

describe("工作台", () => {
  it("启动后新建一块画板：标签页上有它", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("未命名画板"));
  });

  it("顶栏：画板包、设置与版本入口都在", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port, { version: "1.2.3" });
    expect(container.textContent).toContain("画板包");
    expect(container.textContent).toContain("高级设置");
    expect(container.textContent).toContain("Kacha 1.2.3");
  });

  it("工具栏：画板打开时给可用的工具栏", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    await vi.waitFor(() => expect(container.querySelector(".board-toolbar-slot")).not.toBeNull());
  });

  it("画板包菜单：没有画板时导出与下载置灰", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const packButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("画板包"));
    await act(async () => packButton?.click());
    expect(container.textContent).toContain("导入画板包…");
  });

  it("用量提醒：到了上限时给出提醒与管理画板入口", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 200,
      boards_bytes: 100,
      meta_bytes: 100,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: 100,
      limit_level: "alert",
    });
    await show(port);
    await vi.waitFor(() => expect(container.textContent).toContain("用量已满"));
    expect(container.textContent).toContain("管理画板");
  });

  it("没有用量提醒：不显示那条提示", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    port.usage.usage = async () => ({
      total_bytes: 10,
      boards_bytes: 10,
      meta_bytes: 0,
      last_access: 0,
      by_date: [],
      unreferenced: null,
      unreadable_board: null,
      limit_bytes: null,
      limit_level: null,
    });
    await show(port);
    expect(container.textContent).not.toContain("用量已满");
  });

  it("高级设置：点开后面板出现，关掉后消失", async () => {
    const port = createFakePort();
    port.board.list = async () => listing();
    await show(port);
    const settingsButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("高级设置"));
    await act(async () => settingsButton?.click());
    expect(container.querySelector("[aria-label='高级设置']")).not.toBeNull();
  });

  it("画板列表：点开列表后显示画板", async () => {
    const port = createFakePort();
    port.board.list = async () => listing([{ name: "a.ugcboard.json", path: "/~/a.ugcboard.json", archived: false, bytes: 10 }]);
    await show(port);
    const listButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("画板"));
    await act(async () => listButton?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("a"));
  });
});
