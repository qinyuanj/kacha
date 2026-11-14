// @vitest-environment jsdom
// 标签页的右键菜单（#127）：「导出画板包…」的标签与置灰原因跟顶部「画板包」菜单同一处定义。
// 桌面壳本切片没有画板包导出时标「尚不可用」并置灰；Web 版照旧。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyHistory } from "../core/history";
import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "../shell/desktop";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { TabBar } from "./TabBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/Kacha/data",
  board_root: "C:/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

function fakeBridge(): DesktopBridge {
  const local = new Proxy({} as DesktopLocalBridge, {
    get: () => () => Promise.reject(new Error("没实现的本地调用")),
  });
  return { info: () => Promise.resolve(INFO), local };
}

const SESSION = {
  key: "k",
  path: "/~/画板/a.ugcboard.json",
  status: "ok" as const,
  board: { format_version: 2, title: "画板", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], extra: {} },
  history: emptyHistory(),
  notice: null,
  saveError: null,
  version: "v",
  conflicted: false,
  missing: false,
};

let container: HTMLDivElement;
let root: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 渲染标签栏并右键第一个标签，弹出菜单。 */
async function openMenu(port: FakePort | Awaited<ReturnType<typeof createDesktopPort>>["port"]): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ShellProvider, { port, children: createElement(TabBar, { sessions: [SESSION], activeKey: "k", onActivate: () => undefined, onClose: () => undefined, onRename: () => undefined, onCreate: () => undefined, onExportPack: () => undefined }) }),
    );
  });
  const tab = container.querySelector(".tab") as HTMLElement;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

describe("标签页右键菜单", () => {
  it("桌面壳：导出画板包标「尚不可用」并置灰", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await openMenu(port);
    const item = container.querySelector('[role="menuitem"]') as HTMLElement;
    expect(item.textContent).toContain("尚不可用");
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("Web 版：导出画板包照旧可用", async () => {
    await openMenu(createFakePort());
    const item = container.querySelector('[role="menuitem"]') as HTMLElement;
    expect(item.textContent).toBe("导出画板包…");
    expect(item.getAttribute("aria-disabled")).toBeNull();
  });
});
