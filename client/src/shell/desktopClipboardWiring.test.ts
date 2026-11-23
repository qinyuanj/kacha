// 端到端接线（#129）：真实桌面桥（mygoBridge）→ 桌面端口 → media.readClipboard。
// 不 mock 桥里的 clipboard 句柄：这条用例就是为了证明「桥上有句柄、端口用得上它」——
// 之前少绑一次服务时，readClipboard 恒为 null，原生粘贴那条路一次都没被调用过。
import { describe, expect, it, vi } from "vitest";

const runtimeCall = vi.fn();
vi.mock("mygo-runtime", () => ({ call: (method: string, ...args: unknown[]) => runtimeCall(method, ...args) }));

function bridgeWith(callFn: (method: string, ...args: unknown[]) => Promise<unknown>) {
  runtimeCall.mockImplementation(callFn);
  return mygoBridge();
}


import { createDesktopPort, type DesktopInfo } from "./desktop";
import { mygoBridge } from "./desktopBridge";
import { PortError } from "./port";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

/** 页面侧只实现读剪贴板要用的那几个方法；其余按「没实现」拒绝。 */
function bridgeWithClipboard(snapshot: { kind: string; text: string; images: string[]; reason: string }): { bridge: ReturnType<typeof mygoBridge>; calls: string[] } {
  const calls: string[] = [];
  const callFn = (method: string): Promise<unknown> => {
    calls.push(method);
    if (method === "Shell.Info") return Promise.resolve(INFO);
    if (method === "Clipboard.Read") return Promise.resolve({ formats: [], ...snapshot });
    return Promise.reject(new Error("没实现：" + method));
  };
  return { bridge: bridgeWith(callFn), calls };
}

describe("原生剪贴板端到端（#129）", () => {
  it("端口读到的快照来自 Clipboard.Read：桥上有句柄时这条路是通的", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const { bridge, calls } = bridgeWithClipboard({ kind: "images", text: "", images: [png], reason: "" });
    const { port } = await createDesktopPort(bridge);
    const content = await port.media.readClipboard();
    expect(content?.kind).toBe("images");
    expect(content?.images[0].type).toBe("image/png");
    expect(content?.images[0].size).toBe(8);
    expect(calls).toContain("Clipboard.Read");
  });

  it("桥读剪贴板失败：抛 PortError，界面明确提示读取失败，不崩", async () => {
    const callFn = (method: string): Promise<unknown> => {
      if (method === "Shell.Info") return Promise.resolve(INFO);
      if (method === "Clipboard.Read") return Promise.reject(new Error("剪贴板被占用"));
      return Promise.reject(new Error("没实现：" + method));
    };
    const { port } = await createDesktopPort(bridgeWith(callFn));
    const error = await port.media.readClipboard().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({ kind: "failed", message: expect.stringContaining("剪贴板被占用") });
  });
});
