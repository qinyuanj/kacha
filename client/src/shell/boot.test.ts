// 桌面启动失败不能进入其他运行链。
import { afterEach, describe, expect, it, vi } from "vitest";

const bootDesktop = vi.fn();
vi.mock("./desktopBoot", () => ({ bootDesktop: () => bootDesktop() }));

import { selectShellPort } from "./boot";

afterEach(() => {
  bootDesktop.mockReset();
});

describe("壳端口的选择", () => {
  it("MyGo 窗口里给桌面端口", async () => {
    const desktop = { port: { userRoot: "C:/Kacha/data" }, info: { version: "0.1.0" } };
    bootDesktop.mockResolvedValue(desktop);
    const port = await selectShellPort();
    expect(port).toBe(desktop.port);
    expect(port.userRoot).toBe("C:/Kacha/data");
  });

  it("桌面壳起不来时原样报告失败", async () => {
    bootDesktop.mockRejectedValue(new Error("数据根不可用"));
    await expect(selectShellPort()).rejects.toThrow("数据根不可用");
  });
});
