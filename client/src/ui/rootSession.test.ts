// 进入界面的会话流程（#137）：桌面壳直接进工作台、本地有密钥就进工作台、否则要粘贴；连不上服务端是致命错误。
import { describe, expect, it, vi } from "vitest";
import { bootSession, submitKey, type SessionProbe } from "./rootSession";

function probe(patch: Partial<SessionProbe> = {}): SessionProbe {
  return {
    requiresLogin: true,
    config: async () => ({ version: "1.2.3", gateway_url: "http://gw" }),
    readStoredKey: () => null,
    current: async () => ({ fingerprint: "f" }),
    login: async () => ({ fingerprint: "f" }),
    storeKey: () => undefined,
    ...patch,
  };
}

describe("启动流程", () => {
  it("桌面壳（不需要登录）：直接进工作台", async () => {
    const result = await bootSession(probe({ requiresLogin: false }));
    expect(result).toEqual({ kind: "ready", version: "1.2.3" });
  });

  it("本地留着密钥且会话有效：直接进工作台", async () => {
    const result = await bootSession(probe({ readStoredKey: () => "sk-x" }));
    expect(result.kind).toBe("ready");
  });

  it("本地没密钥：要粘贴", async () => {
    const result = await bootSession(probe());
    expect(result).toEqual({ kind: "enter", version: "1.2.3" });
  });

  it("会话失效（401）：回到粘贴界面", async () => {
    const current = vi.fn(async () => {
      throw new Error("unauthorized");
    });
    const result = await bootSession(probe({ readStoredKey: () => "sk-x", current }));
    expect(result.kind).toBe("enter");
  });

  it("读壳信息失败：致命错误，工作台起不来", async () => {
    const config = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await bootSession(probe({ config }));
    expect(result.kind).toBe("fatal");
    if (result.kind === "fatal") expect(result.message).toContain("无法连接 Kacha 服务端");
  });
});

describe("提交密钥", () => {
  it("成功：进工作台", async () => {
    const storeKey = vi.fn();
    const s = { ...probe(), login: vi.fn(async () => ({ fingerprint: "f" })), storeKey } as unknown as SessionProbe;
    const result = await submitKey(s, "sk-x");
    expect(result.kind).toBe("ready");
    expect(storeKey).toHaveBeenCalledWith("sk-x");
  });

  it("失败：给出错误", async () => {
    const s = { ...probe(), login: vi.fn(async () => {
      throw new Error("密钥无效");
    }) } as unknown as SessionProbe;
    const result = await submitKey(s, "sk-bad");
    expect(result).toEqual({ kind: "error", message: "密钥无效" });
  });
});
