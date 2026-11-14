import { describe, expect, it } from "vitest";

import { DesktopPortError, LOCAL_FINGERPRINT, openDesktopShell, type DesktopBridge, type DesktopInfo } from "./desktop";

/** 假桥：测试不碰真窗口，只喂一份壳信息（或一个失败）。 */
function fakeBridge(overrides: Partial<DesktopInfo> = {}, failure?: Error): DesktopBridge {
  const info: DesktopInfo = {
    version: "0.1.0",
    user_data_root: "C:/Users/me/AppData/Roaming/Kacha/data",
    board_root: "C:/Users/me/AppData/Roaming/Kacha/data/画板",
    features: { generation: false, usage: false, pack_export: false },
    ...overrides,
  };
  return {
    info: () => (failure ? Promise.reject(failure) : Promise.resolve(info)),
  };
}

describe("桌面壳适配器", () => {
  it("把壳信息折成用户数据根、画板根与版本", async () => {
    const shell = await openDesktopShell(fakeBridge());
    expect(shell.userRoot).toBe("C:/Users/me/AppData/Roaming/Kacha/data");
    expect(shell.boardRoot).toBe("C:/Users/me/AppData/Roaming/Kacha/data/画板");
    expect(shell.version).toBe("0.1.0");
  });

  it("本切片没有的能力在 features 里都是关的", async () => {
    const shell = await openDesktopShell(fakeBridge());
    expect(shell.features).toEqual({ generation: false, usage: false, packExport: false });
  });

  it("关掉的能力调用时给出 unavailable，并带上能力名", async () => {
    const shell = await openDesktopShell(fakeBridge());
    expect(() => shell.unavailable("generation")).toThrow(DesktopPortError);
    try {
      shell.unavailable("generation");
    } catch (e) {
      const error = e as DesktopPortError;
      expect(error.kind).toBe("unavailable");
      expect(error.feature).toBe("generation");
      expect(error.message).toContain("生成");
      expect(error.message).toContain("尚不可用");
    }
  });

  it("用量与画板包导出同样报 unavailable，不假装成功", async () => {
    const shell = await openDesktopShell(fakeBridge());
    for (const feature of ["usage", "packExport"] as const) {
      expect(() => shell.unavailable(feature)).toThrow(DesktopPortError);
    }
  });

  it("会话返回本机合成身份，不需要登录，也没有会话过期", async () => {
    const shell = await openDesktopShell(fakeBridge());
    await expect(shell.session.current()).resolves.toEqual({ fingerprint: LOCAL_FINGERPRINT, requiresLogin: false });
    const off = shell.session.onExpired(() => {
      throw new Error("桌面壳不该有过期回调");
    });
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("桥失败时折成 failed，消息保持原文", async () => {
    await expect(openDesktopShell(fakeBridge({}, new Error("用户数据根不可用")))).rejects.toMatchObject({
      kind: "failed",
      message: "用户数据根不可用",
    });
  });
});
