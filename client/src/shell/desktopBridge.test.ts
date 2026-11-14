// 真实桌面桥（#127 / #129）：把 MyGo 绑定折成 DesktopBridge。
// 这里钉住「页面调用名 = Go 侧绑定名」：名字错了 Go 会返回 notBound，前端只会静默退回
// paste 事件——原生粘贴那条路就白做了，而且没有任何报错。
import { describe, expect, it } from "vitest";

import type { DesktopInfo } from "./desktop";
import { mygoBridge } from "./desktopBridge";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

/** 记下每次调用的方法名，按名字回值；不起 MyGo runtime。 */
function recordingBridge() {
  const calls: { method: string; args: unknown[] }[] = [];
  const callFn = (method: string, ...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    if (method === "Shell.Info") return Promise.resolve(INFO);
    if (method === "Clipboard.Read") return Promise.resolve({ kind: "empty", text: "", images: [], reason: "", formats: [] });
    if (method === "Local.ReadBoard") return Promise.resolve({ main: null, bak: null, version: null });
    return Promise.reject(new Error("没实现：" + method));
  };
  return { bridge: mygoBridge(callFn), calls };
}

describe("剪贴板句柄（#129）", () => {
  it("桥上有 clipboard 句柄：没有它，readClipboard 恒为 null，原生粘贴不会被调用", () => {
    const { bridge } = recordingBridge();
    expect(bridge.clipboard).toBeDefined();
  });

  it("clipboard.read() 调用 Clipboard.Read——与 Go 侧 BindAs(\"Clipboard\", ...) 一致", async () => {
    const { bridge, calls } = recordingBridge();
    await bridge.clipboard!.read();
    expect(calls.map((c) => c.method)).toEqual(["Clipboard.Read"]);
  });

  it("快照原样交给页面：类别、图片、原因都不在桥里改写", async () => {
    const { bridge } = recordingBridge();
    await expect(bridge.clipboard!.read()).resolves.toEqual({ kind: "empty", text: "", images: [], reason: "", formats: [] });
  });

  it("已有的句柄不受影响：info 仍调 Shell.Info，local 仍按 PascalCase 调", async () => {
    const { bridge, calls } = recordingBridge();
    await bridge.info();
    await bridge.local.readBoard("/x");
    expect(calls.map((c) => c.method)).toEqual(["Shell.Info", "Local.ReadBoard"]);
  });
});
