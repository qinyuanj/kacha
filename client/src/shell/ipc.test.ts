import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiError";
import { ipc } from "./ipc";

afterEach(() => vi.unstubAllGlobals());

describe("文件读写连不上服务端", () => {
  it("与其他接口一样报网络失败（status 0），不抛原生 TypeError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const network = { name: "ApiError", status: 0, code: "network" };
    await expect(ipc.readFileBytes("/~/a.png")).rejects.toMatchObject(network);
    await expect(ipc.writeNewFile("/~/a.png", new Uint8Array([1]))).rejects.toMatchObject(network);
    await expect(ipc.readFileBytes("/~/a.png")).rejects.toBeInstanceOf(ApiError);
  });
});
