// @vitest-environment jsdom
// 网关端口（#152）：设置面板的模型发现与密钥管理必须穿过 Go 绑定，不能留在前端替身里。
import { describe, expect, it } from "vitest";
import { refreshModels, type SettingsPorts } from "../core/settings";
import { PortError } from "./port";
import type { DesktopBridge, DesktopGatewayResponse } from "./desktop";
import { createGatewayPorts } from "./desktopGateway";
import { base64Of } from "../core/base64";

const SYNTHETIC = "sk-spec152-synthetic-not-real";
const INFO = { version: "test", user_data_root: "C:/data", board_root: "C:/data/画板", features: { generation: false, usage: false, pack_export: false } };

function fakeBridge(res: DesktopGatewayResponse | Error, calls: { method: string; args: unknown[] }[], stored: { key: string | null } = { key: null }): DesktopBridge {
  return {
    info: async () => INFO,
    local: {} as DesktopBridge["local"],
    gateway: {
      request: async (...args) => {
        calls.push({ method: "Gateway.Request", args });
        if (res instanceof Error) throw res;
        return res;
      },
      readApiKey: async () => {
        calls.push({ method: "Gateway.ReadApiKey", args: [] });
        return stored.key;
      },
      writeApiKey: async (key) => {
        calls.push({ method: "Gateway.WriteApiKey", args: [key] });
        stored.key = key;
      },
      deleteApiKey: async () => {
        calls.push({ method: "Gateway.DeleteApiKey", args: [] });
        stored.key = null;
      },
    },
  };
}

function withGateway(bridge: DesktopBridge): SettingsPorts {
  return {
    ...createGatewayPorts(bridge),
    readSettings: async () => null,
    defaultBaseUrl: async () => "http://gw:3001",
    writeSettings: async () => undefined,
    readModelsCache: async () => null,
    writeModelsCache: async () => undefined,
    now: () => new Date("2026-11-17T00:00:00.000Z"),
    log: () => undefined,
  };
}

describe("网关壳端口", () => {
  it("模型发现经 Gateway.Request 发真实请求，按响应与请求头返回给 core", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const bridge = fakeBridge({ status: 200, headers: { "X-Oneapi-Request-Id": "r-1" }, body: JSON.stringify({ data: [{ id: "m1" }] }) }, calls);
    const result = await refreshModels(withGateway(bridge), "http://gw:3001", SYNTHETIC, null);
    expect(result).toMatchObject({ ok: true, discovery: { source: "live", ids: ["m1"] } });
    expect(calls[0]).toMatchObject({ method: "Gateway.Request", args: ["http://gw:3001/v1/models", "GET", { Authorization: "Bearer " + SYNTHETIC, Accept: "application/json" }, ""] });
  });

  it("鉴权与网络错误都折叠成明确文案，秘密不进提示", async () => {
    const authCalls: { method: string; args: unknown[] }[] = [];
    const auth = fakeBridge({ status: 401, headers: {}, body: JSON.stringify({ error: { message: "bad " + SYNTHETIC } }) }, authCalls);
    const authResult = await refreshModels(withGateway(auth), "http://gw:3001", SYNTHETIC, null);
    expect(authResult).toMatchObject({ ok: false, message: "鉴权失败：HTTP 401：bad [REDACTED]" });
    expect(JSON.stringify(authResult)).not.toContain(SYNTHETIC);

    const netCalls: { method: string; args: unknown[] }[] = [];
    const net = fakeBridge(new Error("dial failed"), netCalls);
    const netResult = await refreshModels(withGateway(net), "http://gw:3001", SYNTHETIC, null);
    expect(netResult).toMatchObject({ ok: false, message: expect.stringMatching(/^网络不可达：/) });
  });

  it("密钥读写与清除都走 Gateway 绑定：默认持久化，由 Go 侧系统保护", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const stored = { key: null as string | null };
    const ports = createGatewayPorts(fakeBridge({ status: 200, headers: {}, body: "{}" }, calls, stored));
    expect(await ports.readApiKey()).toBeNull();
    await ports.writeApiKey(SYNTHETIC);
    expect(await ports.readApiKey()).toBe(SYNTHETIC);
    await ports.deleteApiKey();
    expect(await ports.readApiKey()).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["Gateway.ReadApiKey", "Gateway.WriteApiKey", "Gateway.ReadApiKey", "Gateway.DeleteApiKey", "Gateway.ReadApiKey"]);
  });

  it("结果图的二进制响应经 body_base64 还原成原始字节，不按 UTF-8 文本损坏", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 64]);
    const bridge = fakeBridge({ status: 200, headers: { "content-type": "image/png" }, body: "", body_base64: base64Of(bytes) } as unknown as DesktopGatewayResponse, calls);
    const ports = createGatewayPorts(bridge);
    const response = await ports.fetch("http://gw/result.png", { method: "GET", headers: { Accept: "image/*" } });
    expect(await response.text()).toBe("");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(calls[0]).toMatchObject({ method: "Gateway.Request", args: ["http://gw/result.png", "GET", { Accept: "image/*" }, ""] });
  });

  it("桥上没有 Gateway 时明确报 unavailable，不空成功", async () => {
    const ports = createGatewayPorts({ info: async () => INFO, local: {} as DesktopBridge["local"] });
    await expect(ports.readApiKey()).rejects.toMatchObject({ kind: "unavailable", feature: "gateway" });
    await expect(ports.writeApiKey(SYNTHETIC)).rejects.toBeInstanceOf(PortError);
    await expect(ports.fetch("http://gw/v1/models", { method: "GET", headers: {} })).rejects.toBeInstanceOf(PortError);
  });
});
