// @vitest-environment jsdom
// 入口与身份（#127）：桌面壳没有登录，界面上不出现「退出」（点它会回到粘贴密钥的界面）。
// Web 版照旧：会话有效时给「退出」按钮。
// App 用替身：替身按 App 的约定渲染（给了 onLogout 才画「退出」），这里验的是 Root 传不传 onLogout。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { Root } from "./Root";
import { ShellProvider } from "./shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../App", async () => {
  const { createElement: h } = await import("react");
  return {
    App: ({ onLogout }: { onLogout?: () => void }) =>
      h("div", null, h("span", null, "工作台"), onLogout ? h("button", null, "退出") : null),
  };
});

let container: HTMLDivElement;
let root: ReactRoot;
let port: FakePort;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  port = createFakePort();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 渲染 Root 并等会话判定落定。 */
async function show(): Promise<void> {
  await act(async () => {
    root.render(createElement(ShellProvider, { port, children: createElement(Root) }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("桌面壳的入口", () => {
  it("端口说不需要登录时不出现「退出」按钮", async () => {
    // 桌面壳：本地身份，没有会话可退出。
    port = createFakePort({ requiresLogin: false, storedKey: null });
    await show();
    expect(container.textContent).toContain("工作台");
    expect(container.textContent).not.toContain("退出");
  });

  it("Web 版照旧给「退出」按钮", async () => {
    // Web 版：本地存着密钥，界面直接进工作台。
    port = createFakePort({ storedKey: "sk-test" });
    await show();
    expect(container.textContent).toContain("工作台");
    expect(container.textContent).toContain("退出");
  });
});
