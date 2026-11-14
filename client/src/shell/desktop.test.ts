// 桌面壳端口（#127）：本切片没有的能力给 unavailable，不伪装成功；本机身份不需要登录。
import { describe, expect, it } from "vitest";

import { createDesktopPort, LOCAL_FINGERPRINT, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "./desktop";
import { PortError, portFailureOf } from "./port";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/Users/me/AppData/Roaming/Kacha/data",
  board_root: "C:/Users/me/AppData/Roaming/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

/** 假桥：测试不碰真窗口与真磁盘。 */
function fakeBridge(overrides: Partial<DesktopInfo> = {}, failure?: Error): DesktopBridge {
  const info = { ...INFO, ...overrides };
  const local = new Proxy({} as DesktopLocalBridge, {
    get: () => () => Promise.reject(new Error("没实现的本地调用")),
  });
  return {
    info: () => (failure ? Promise.reject(failure) : Promise.resolve(info)),
    local,
  };
}

describe("桌面壳端口", () => {
  it("用户数据根是本机真实目录，画板根在它下面", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    expect(port.userRoot).toBe("C:/Users/me/AppData/Roaming/Kacha/data");
  });

  it("本切片没有的能力在 features 里都是关的", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    expect(port.features).toEqual({ generation: false, usage: false, packExport: false, tidy: false });
  });

  it("生成报 unavailable，并带上能力名", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.core.runDeps.fetch("/api/x", { method: "GET", headers: {} })).rejects.toBeInstanceOf(PortError);
    try {
      await port.core.runDeps.fetch("/api/x", { method: "GET", headers: {} });
    } catch (e) {
      const failure = portFailureOf(e);
      expect(failure.kind).toBe("unavailable");
      expect(failure.feature).toBe("generation");
      expect(failure.message).toContain("生成");
      expect(failure.message).toContain("尚不可用");
    }
  });

  it("用量与画板包导出同样报 unavailable，不假装成功", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.usage.usage()).rejects.toMatchObject({ kind: "unavailable", feature: "usage" });
    await expect(port.pack.exportPack("x", { task_dirs: [], texts: [], files: [], omitted: [] })).rejects.toMatchObject({ kind: "unavailable", feature: "packExport" });
  });

  it("归档与整理也报 unavailable", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.board.archive("a", "b")).rejects.toMatchObject({ kind: "unavailable", feature: "archive" });
    await expect(port.board.measure("{}")).rejects.toMatchObject({ kind: "unavailable", feature: "tidy" });
  });

  it("会话返回本机合成身份，不需要登录，也没有会话过期", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    await expect(port.session.current()).resolves.toEqual({ fingerprint: LOCAL_FINGERPRINT });
    expect(port.session.readStoredKey()).toBeNull();
    const off = port.session.onExpired(() => {
      throw new Error("桌面壳不该有过期回调");
    });
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("壳信息读不出来时直接失败，不静默降级", async () => {
    await expect(createDesktopPort(fakeBridge({}, new Error("用户数据根不可用")))).rejects.toThrow("用户数据根不可用");
  });
});
