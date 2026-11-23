// @vitest-environment jsdom
// 高级设置的接线（#137）：载入、保存与模型刷新。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePort } from "../shell/testing/fakePort";
import { ShellProvider } from "./shell";
import { useSettings } from "./useSettings";

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

describe("高级设置接线", () => {
  it("载入：状态变成已载入", async () => {
    const port = createFakePort();
    let loaded = false;
    const Probe = () => {
      loaded = useSettings().loaded;
      return null;
    };
    await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
    await act(async () => undefined);
    expect(loaded).toBe(true);
  });

  it("模型刷新失败：给回失败结局和可展示说明", async () => {
    const port = createFakePort();
    const seen: { ok: boolean; message?: string }[] = [];
    const Probe = () => {
      const settings = useSettings();
      void settings.testConnection("http://gw", "sk-x").then((r) => seen.push(r));
      return null;
    };
    await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
    await act(async () => undefined);
    // 替身的网关固定返回 500：必须把失败结局和一句可展示的话交回来。
    expect(seen.length).toBeGreaterThan(0);
    for (const result of seen) expect(result).toEqual({ ok: false, message: expect.stringMatching(/\S/) });
  });

  it("保存：写不进去时给一句说明", async () => {
    const port = createFakePort();
    port.core.settingsPorts.writeSettings = async () => {
      throw new Error("写不进去");
    };
    let problem: string | null = "unset";
    const Probe = () => {
      const settings = useSettings();
      return createElement("button", { onClick: () => void settings.save({ base_url: "http://gw", concurrency: 2 } as never, "sk-x").then((r) => (problem = r)) }, "保存");
    };
    await act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(Probe) })));
    await act(async () => undefined);
    await act(async () => container.querySelector("button")?.click());
    await act(async () => undefined);
    expect(problem).toBe("保存设置失败：写不进去");
  });
});