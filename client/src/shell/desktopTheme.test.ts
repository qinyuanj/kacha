// @vitest-environment jsdom
// 原生主题同步（#221）：桌面适配器把档位原文交给 Go 侧 Shell.SetTheme。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo } from "./desktop";
import { mygoBridge } from "./desktopBridge";
import { createFakePort } from "./testing/fakePort";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/data",
  board_root: "C:/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

/** 记录页面侧方法调用的假桥；没实现的方法按拒绝处理。 */
function recordingBridge(handlers: Record<string, (...args: unknown[]) => Promise<unknown>>) {
  const calls: { method: string; args: unknown[] }[] = [];
  const callFn = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    const handler = handlers[method];
    return handler ? handler(...args) : Promise.reject(new Error("没实现：" + method));
  };
  return { bridge: mygoBridge(callFn), calls };
}

describe("原生主题同步（#221）", () => {
  it("档位原文经 Shell.SetTheme 交给壳（system 不翻成 dark）", async () => {
    const { bridge, calls } = recordingBridge({
      "Shell.Info": () => Promise.resolve(INFO),
      "Shell.SetTheme": () => Promise.resolve(undefined),
    });
    const { port } = await createDesktopPort(bridge);
    for (const choice of ["dark", "light", "system"] as const) await port.ui.setNativeTheme(choice);
    expect(calls.filter((c) => c.method === "Shell.SetTheme").map((c) => c.args)).toEqual([["dark"], ["light"], ["system"]]);
  });

  it("宿主没有这个方法时不算失败：本页已经按自己的主题画好了", async () => {
    const bridge: DesktopBridge = { info: async () => INFO, local: {} as DesktopBridge["local"] };
    const { port } = await createDesktopPort(bridge);
    await expect(port.ui.setNativeTheme("dark")).resolves.toBeUndefined();
  });

  it("内存替身同形：记下档位，行为与真实适配器一致", async () => {
    const fake = createFakePort();
    await fake.ui.setNativeTheme("light");
    await fake.ui.setNativeTheme("system");
    expect(fake.calls.nativeTheme).toEqual(["light", "system"]);
    expect(typeof fake.ui.setNativeTheme).toBe("function");
  });
});
