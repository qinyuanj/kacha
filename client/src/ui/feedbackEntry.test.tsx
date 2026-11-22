// @vitest-environment jsdom
// 首屏反馈入口（#206）：不打开画板也能在工具栏看到并打开反馈对话框。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { AppToolbar } from "./appPanels";
import type { UpdateControl } from "./useUpdate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("首屏反馈入口（#206）", () => {
  it("工具栏显示反馈按钮并调用打开回调", async () => {
    const onOpenFeedback = vi.fn();
    await act(async () => root.render(createElement(ShellProvider, { port: createFakePort(), children: createElement(AppToolbar, {
      setToolbarSlot: vi.fn(),
      canvasReady: false,
      runIndicator: { active: [], activity: { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] }, titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() },
      packMenuOpen: false,
      packMenuDisabled: true,
      onTogglePackMenu: vi.fn(),
      version: "1.8.0",
      ready: true,
      onOpenChangelog: vi.fn(),
      settingsLoaded: true,
      onOpenSettings: vi.fn(),
      update: { snapshot: { status: "idle" }, state: { preparing: false, prepareError: "", installError: "" }, check: vi.fn(), install: vi.fn() } as unknown as UpdateControl,
      onOpenFeedback,
      theme: { choice: "dark", effective: "dark", choose: vi.fn() },
    }) })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("反馈"));
    expect(button).not.toBeUndefined();
    await act(async () => button!.click());
    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });

  it("反馈能力关闭时入口标暂不可用，仍可点击重试打开", async () => {
    const onOpenFeedback = vi.fn();
    await act(async () => root.render(createElement(ShellProvider, { port: createFakePort({ missing: ["feedback"] }), children: createElement(AppToolbar, {
      setToolbarSlot: vi.fn(),
      canvasReady: false,
      runIndicator: { active: [], activity: { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] }, titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() },
      packMenuOpen: false,
      packMenuDisabled: true,
      onTogglePackMenu: vi.fn(),
      version: "1.8.0",
      ready: true,
      onOpenChangelog: vi.fn(),
      settingsLoaded: true,
      onOpenSettings: vi.fn(),
      update: { snapshot: { status: "idle" }, state: { preparing: false, prepareError: "", installError: "" }, check: vi.fn(), install: vi.fn() } as unknown as UpdateControl,
      onOpenFeedback,
      feedbackAvailable: false,
      theme: { choice: "dark", effective: "dark", choose: vi.fn() },
    }) })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("反馈"));
    expect(button?.textContent).toContain("暂不可用");
    await act(async () => button!.click());
    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });
});
