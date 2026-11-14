import { afterEach, describe, expect, it, vi } from "vitest";

const isMyGo = vi.fn();
const call = vi.fn();
vi.mock("mygo-runtime", () => ({ isMyGo: () => isMyGo(), call: (method: string) => call(method) }));

const INFO = {
  version: "0.1.0",
  user_data_root: "C:/Kacha/data",
  board_root: "C:/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

/** 每次用例都重新导入，模块内的缓存不串。 */
async function freshBoot() {
  vi.resetModules();
  const { bootDesktop } = await import("./desktopBoot");
  return bootDesktop;
}

afterEach(() => {
  isMyGo.mockReset();
  call.mockReset();
});

describe("桌面壳启动", () => {
  it("普通浏览器里不解析壳，返回 null", async () => {
    isMyGo.mockReturnValue(false);
    const boot = await freshBoot();
    await expect(boot()).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("MyGo 窗口里读一次 Shell.Info 并记住", async () => {
    isMyGo.mockReturnValue(true);
    call.mockResolvedValue(INFO);
    const boot = await freshBoot();
    const shell = await boot();
    expect(shell?.version).toBe("0.1.0");
    expect(shell?.userRoot).toBe("C:/Kacha/data");
    expect(call).toHaveBeenCalledWith("Shell.Info");
    await expect(boot()).resolves.toBe(shell);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
