// @vitest-environment jsdom
// 桌面壳的原生剪贴板与另存为（#124 A1 / A2）：桌面适配器走 Go 绑定。
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeCall = vi.fn();
vi.mock("mygo-runtime", () => ({ call: (method: string, ...args: unknown[]) => runtimeCall(method, ...args) }));

function bridgeWith(callFn: (method: string, ...args: unknown[]) => Promise<unknown>) {
  runtimeCall.mockImplementation(callFn);
  return mygoBridge();
}


import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "./desktop";
import { mygoBridge } from "./desktopBridge";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

/** 记录页面侧方法调用的假桥；没实现的方法按拒绝处理。 */
function recordingBridge(handlers: Record<string, (...args: unknown[]) => Promise<unknown>>): { bridge: DesktopBridge; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const callFn = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    const handler = handlers[method];
    if (handler) return handler(...args);
    return Promise.reject(new Error("没实现：" + method));
  };
  return { bridge: bridgeWith(callFn), calls };
}

/** 只实现一个方法的本地桥，其余拒绝。 */
function localWith(prop: string, impl: (...args: never[]) => Promise<unknown>): DesktopLocalBridge {
  return new Proxy({} as DesktopLocalBridge, {
    get: (_target, name: string) => (name === prop ? impl : () => Promise.reject(new Error("没实现的本地调用：" + name))),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  // 清掉 navigator.clipboard 的替身，别串到下一个用例。
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("桌面复制文本走 Go 原生剪贴板（#124 A1）", () => {
  it("copyText 调用 Clipboard.WriteText，不碰 navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { bridge, calls } = recordingBridge({
      "Shell.Info": () => Promise.resolve(INFO),
      "Clipboard.WriteText": () => Promise.resolve({ ok: true, kind: "", message: "" }),
    });
    const { port } = await createDesktopPort(bridge);
    await port.media.copyText("kacha:clip:v1:1");
    expect(calls).toContainEqual({ method: "Clipboard.WriteText", args: ["kacha:clip:v1:1"] });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Go 写后读回核实失败：copyText 拒绝，调用点会提示标记可能不生效", async () => {
    const { bridge } = recordingBridge({
      "Shell.Info": () => Promise.resolve(INFO),
      "Clipboard.WriteText": () => Promise.resolve({ ok: false, kind: "failed", message: "复制文本失败：系统剪贴板没有写进去，请重试" }),
    });
    const { port } = await createDesktopPort(bridge);
    await expect(port.media.copyText("kacha:clip:v1:1")).rejects.toMatchObject({ kind: "failed", message: expect.stringContaining("剪贴板") });
  });

  it("桥没有剪贴板：报 unavailable，不回退浏览器剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const local = localWith("readBoard", (() => Promise.reject(new Error("没实现"))) as never);
    const { port } = await createDesktopPort({ info: () => Promise.resolve(INFO), local });
    await expect(port.media.copyText("kacha:clip:v1:1")).rejects.toMatchObject({ kind: "unavailable", feature: "copyText" });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("桌面另存为真的能存（#124 A2 / #130）", () => {
  it("saveCopyAs 经 Local.SaveCopyAs 交给 Go 打开另存为对话框", async () => {
    const saved: string[] = [];
    const local = localWith("saveCopyAs", ((path: string) => {
      saved.push(path);
      return Promise.resolve({ ok: true, kind: "", message: "", version: "" });
    }) as never);
    const { port } = await createDesktopPort({ info: () => Promise.resolve(INFO), local });
    await expect(port.media.saveCopyAs("C:/data/参考/cat.png")).resolves.toEqual({ kind: "saved" });
    expect(saved).toEqual(["C:/data/参考/cat.png"]);
  });

  it("用户取消另存为：返回 cancelled，调用点不会提示已开始下载", async () => {
    const local = localWith("saveCopyAs", (() => Promise.resolve({ ok: false, kind: "cancelled", message: "已取消", version: "" })) as never);
    const { port } = await createDesktopPort({ info: () => Promise.resolve(INFO), local });
    await expect(port.media.saveCopyAs("C:/data/参考/cat.png")).resolves.toEqual({ kind: "cancelled" });
  });

  it("其它写失败照旧抛 PortError，不伪装成功", async () => {
    const local = localWith("saveCopyAs", (() => Promise.resolve({ ok: false, kind: "failed", message: "磁盘满了", version: "" })) as never);
    const { port } = await createDesktopPort({ info: () => Promise.resolve(INFO), local });
    await expect(port.media.saveCopyAs("C:/data/参考/cat.png")).rejects.toMatchObject({ kind: "failed" });
  });
});
