// 壳端口的选择（#127）：界面与组合根只问这一个接缝；
// MyGo 窗口里给桌面端口，普通浏览器里给 Web 端口，桌面壳起不来时退回 Web 端口。
import { afterEach, describe, expect, it, vi } from "vitest";

const bootDesktop = vi.fn();
vi.mock("./desktopBoot", () => ({ bootDesktop: () => bootDesktop() }));

import { selectShellPort } from "./boot";
import { webPort } from "./webPort";

afterEach(() => {
  bootDesktop.mockReset();
});

describe("壳端口的选择", () => {
  it("普通浏览器里给 Web 端口", async () => {
    bootDesktop.mockResolvedValue(null);
    await expect(selectShellPort()).resolves.toBe(webPort);
  });

  it("MyGo 窗口里给桌面端口", async () => {
    const desktop = { port: { userRoot: "C:/Kacha/data" }, info: { version: "0.1.0" } };
    bootDesktop.mockResolvedValue(desktop);
    const port = await selectShellPort();
    expect(port).toBe(desktop.port);
    expect(port.userRoot).toBe("C:/Kacha/data");
  });

  it("桌面壳起不来时退回 Web 端口，页面仍能起来", async () => {
    bootDesktop.mockRejectedValue(new Error("用户数据根不可用"));
    await expect(selectShellPort()).resolves.toBe(webPort);
  });
});
