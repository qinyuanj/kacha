// 壳层的同源 HTTP 出口（#137）：网络失败统一报 status 0、401 通知会话失效、非 2xx 折成 ApiError。
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiError";
import { api, apiResponse, apiText, onSessionExpired, send } from "./ipcHttp";

afterEach(() => vi.unstubAllGlobals());

/** 造一个 fetch 替身：按 URL 返回给定的 Response。 */
function stubFetch(response: Response | (() => Response)): void {
  vi.stubGlobal("fetch", async () => (typeof response === "function" ? response() : response));
}

describe("同源请求", () => {
  it("连不上服务端：报网络失败（status 0），不抛原生 TypeError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(send("/api/x")).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("401 通知会话失效", async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    stubFetch(new Response(null, { status: 401 }));
    await send("/api/x");
    expect(expired).toHaveBeenCalled();
    off();
  });

  it("非 2xx 折成 ApiError，保留状态码与错误体里的 code / message", async () => {
    stubFetch(new Response(JSON.stringify({ code: "board_slots_full", message: "画板位已满" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    await expect(api("/api/x")).rejects.toMatchObject({ status: 409, code: "board_slots_full", message: "画板位已满" });
  });

  it("错误体不是 JSON：用状态码文案", async () => {
    stubFetch(new Response("<html>502</html>", { status: 502 }));
    await expect(api("/api/x")).rejects.toMatchObject({ status: 502, code: "http_error", message: "服务端返回 HTTP 502" });
  });

  it("错误体带 upstream_status 时一并带上", async () => {
    stubFetch(new Response(JSON.stringify({ code: "upstream", message: "网关错误", upstream_status: 429 }), { status: 502 }));
    await expect(api("/api/x")).rejects.toMatchObject({ status: 502, upstreamStatus: 429 });
  });

  it("2xx 的响应体留给调用方读", async () => {
    stubFetch(new Response("hello", { status: 200 }));
    const res = await apiResponse("/api/x");
    expect(await res.text()).toBe("hello");
  });

  it("204 无内容", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(api("/api/x")).resolves.toBeUndefined();
  });

  it("元数据接口按文本读：null 与空串都是没有", async () => {
    stubFetch(new Response("null", { status: 200 }));
    await expect(apiText("/api/settings")).resolves.toBeNull();
    stubFetch(new Response("", { status: 200 }));
    await expect(apiText("/api/settings")).resolves.toBeNull();
  });

  it("元数据接口读的是 JSON 原文，不解析成对象", async () => {
    stubFetch(new Response(JSON.stringify({ base_url: "http://x" }), { status: 200 }));
    await expect(apiText("/api/settings")).resolves.toBe(JSON.stringify({ base_url: "http://x" }));
  });

  it("元数据接口读失败：报 read_failed", async () => {
    stubFetch(new Response(null, { status: 500 }));
    await expect(apiText("/api/settings")).rejects.toBeInstanceOf(ApiError);
    await expect(apiText("/api/settings")).rejects.toMatchObject({ code: "read_failed" });
  });
});
