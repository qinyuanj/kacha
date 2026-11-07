import { describe, expect, it } from "vitest";
import { isChromeRestrictedPort, startOnSafePort } from "./ports";

describe("isChromeRestrictedPort", () => {
  it("认出 #75 里撞上的 SIP 端口与动态端口段里的其它受限端口", () => {
    // 4190、6679 只在 Fetch 规范的 bad port 列表里，Chromium 尚未收录，同样避开。
    for (const port of [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6669, 6679, 6697, 10080]) {
      expect(isChromeRestrictedPort(port), String(port)).toBe(true);
    }
  });

  it("放行相邻的普通端口", () => {
    for (const port of [1718, 4191, 5059, 5062, 6664, 6670, 10079, 10081, 49152, 65535]) {
      expect(isChromeRestrictedPort(port), String(port)).toBe(false);
    }
  });
});

describe("startOnSafePort", () => {
  /** 按顺序分出给定端口的启动器，记录释放了哪些端口。 */
  function fakeStarter(ports: number[]) {
    const released: number[] = [];
    let next = 0;
    const start = async () => {
      const port = ports[next++];
      return { port, value: `srv:${port}`, release: async () => void released.push(port) };
    };
    return { start, released, calls: () => next };
  }

  it("第一次分到安全端口就直接用，不释放", async () => {
    const f = fakeStarter([50000]);
    await expect(startOnSafePort("桩", f.start)).resolves.toEqual({ port: 50000, value: "srv:50000" });
    expect(f.released).toEqual([]);
  });

  it("分到受限端口时释放后重启，直到拿到安全端口", async () => {
    const f = fakeStarter([5060, 6000, 50001]);
    await expect(startOnSafePort("服务端", f.start)).resolves.toEqual({ port: 50001, value: "srv:50001" });
    expect(f.released).toEqual([5060, 6000]);
  });

  it("超过重试上限时报错并说明是谁、分到了哪些端口", async () => {
    const f = fakeStarter([5060, 5061, 6000]);
    await expect(startOnSafePort("服务端", f.start, 3)).rejects.toThrow(/服务端.*3 次.*5060, 5061, 6000/);
    expect(f.calls()).toBe(3);
    expect(f.released).toEqual([5060, 5061, 6000]);
  });
});
