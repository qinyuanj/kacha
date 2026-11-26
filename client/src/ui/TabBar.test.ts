// @vitest-environment jsdom
// 标签页的右键菜单（#127）：「导出画板包…」的标签与置灰原因跟顶部「画板包」菜单同一处定义。
// 桌面壳本切片没有画板包导出时标「尚不可用」并置灰。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNAVAILABLE_TEXT } from "../core/uiText";

import { emptyHistory } from "../core/history";
import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "../shell/desktop";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import type { Session } from "./useBoardSessions";
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
    expect(item.textContent).toContain(UNAVAILABLE_TEXT);
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("端口声明导出可用时：导出画板包照旧可用", async () => {
    await openMenu(createFakePort());
    const item = container.querySelector('[role="menuitem"]') as HTMLElement;
    expect(item.textContent).toBe("导出画板包…");
    expect(item.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("标签页栏的行为", () => {
  /** 用内存端口渲染标签栏。 */
  async function renderBar(props: Record<string, unknown> = {}): Promise<FakePort> {
    const port = createFakePort();
    await act(async () => {
      root.render(
        createElement(ShellProvider, {
          port,
          children: createElement(TabBar, {
            sessions: [SESSION],
            activeKey: "k",
            onActivate: () => undefined,
            onClose: () => undefined,
            onRename: () => undefined,
            onCreate: () => undefined,
            onExportPack: () => undefined,
            ...props,
          }),
        }),
      );
    });
    return port;
  }

  it("画板读不出来时写文件名并标红，不进入改名", async () => {
    const bad: Session = { key: "k", path: "/b/x.kacha", status: "corrupt", reason: "坏了" };
    await act(async () => {
      root.render(createElement(ShellProvider, { port: createFakePort(), children: createElement(TabBar, { sessions: [bad], activeKey: null, onActivate: () => undefined, onClose: () => undefined, onRename: () => undefined, onCreate: () => undefined, onExportPack: () => undefined }) }));
    });
    expect(container.querySelector(".tab-title")?.textContent).toBe("x.kacha");
    expect((container.querySelector(".tab") as HTMLElement).className).toContain("tab-bad");
    await act(async () => { container.querySelector(".tab")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(container.querySelector("input")).toBeNull();
    await act(async () => { container.querySelector(".tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })); });
    expect(container.querySelector('[role="menuitem"]')?.getAttribute("aria-disabled")).toBe("true");
  });

  it("保存失败时标红", async () => {
    await act(async () => {
      root.render(createElement(ShellProvider, { port: createFakePort(), children: createElement(TabBar, { sessions: [{ ...SESSION, saveError: "写不进去" }], activeKey: null, onActivate: () => undefined, onClose: () => undefined, onRename: () => undefined, onCreate: () => undefined, onExportPack: () => undefined }) }));
    });
    expect((container.querySelector(".tab") as HTMLElement).className).toContain("tab-bad");
  });

  it("改名输入普通键不提交", async () => {
    await renderBar();
    await act(async () => { container.querySelector(".tab")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    await act(async () => { (container.querySelector("input") as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("标签写画板标题，当前标签高亮", async () => {
    await renderBar();
    expect(container.querySelector(".tab-title")?.textContent).toBe("画板");
    expect((container.querySelector(".tab") as HTMLElement).className).toContain("tab-active");
  });

  it("单击标签切换画板", async () => {
    const calls: string[] = [];
    await renderBar({ onActivate: (k: string) => calls.push(k) });
    await act(async () => (container.querySelector(".tab") as HTMLElement).click());
    expect(calls).toEqual(["k"]);
  });

  it("双击进改名：草稿是画板标题，回车提交", async () => {
    const calls: [string, string][] = [];
    await renderBar({ onRename: (k: string, t: string) => calls.push([k, t]) });
    await act(async () => {
      container.querySelector(".tab")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("画板");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(calls).toEqual([["k", "画板"]]);
  });

  it("改名时按 Esc 取消，不改名", async () => {
    const calls: string[] = [];
    await renderBar({ onRename: (k: string) => calls.push(k) });
    await act(async () => {
      container.querySelector(".tab")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector("input") as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(calls).toEqual([]);
    expect(container.querySelector("input")).toBeNull();
  });

  it("× 关闭标签，且不触发切换", async () => {
    const closes: string[] = [];
    const activates: string[] = [];
    await renderBar({ onClose: (k: string) => closes.push(k), onActivate: (k: string) => activates.push(k) });
    await act(async () => (container.querySelector(".tab-close") as HTMLElement).click());
    expect(closes).toEqual(["k"]);
    expect(activates).toEqual([]);
  });

  it("右键菜单点「导出画板包」调 onExportPack", async () => {
    const calls: string[] = [];
    await renderBar({ onExportPack: (k: string) => calls.push(k) });
    await act(async () => {
      container.querySelector(".tab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    await act(async () => (container.querySelector('[role="menuitem"]') as HTMLElement).click());
    expect(calls).toEqual(["k"]);
  });

  it("标签栏不再放全局画板列表入口", async () => {
    await renderBar();
    expect(container.querySelector(".tab-list")).toBeNull();
    expect(container.textContent).not.toContain("画板列表");
  });

  it("新建按钮调 onCreate", async () => {
    let created = 0;
    await renderBar({ onCreate: () => (created += 1) });
    await act(async () => (container.querySelector(".tab-new") as HTMLElement).click());
    expect(created).toBe(1);
  });
});
