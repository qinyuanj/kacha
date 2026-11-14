// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiError";
import { browser, ipc, packUpload } from "./ipc";

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

describe("画板包的 HTTP 出口", () => {
  /** 记下请求并按脚本回响应。 */
  function stubFetch(reply: (url: string, init?: RequestInit) => Response): string[] {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push(String(url));
      return reply(String(url), init);
    });
    return seen;
  }

  it("导出的 hash 阶段：问服务端要逐文件事实", async () => {
    const seen = stubFetch(() => new Response(JSON.stringify([{ entry: "a.png", size: 10, sha256: "s" }]), { status: 200 }));
    const facts = await ipc.boardPackFacts({ task_dirs: ["/~/任务"], files: [] });
    expect(facts).toEqual([{ entry: "a.png", size: 10, sha256: "s" }]);
    expect(seen[0]).toContain("/api/packs/export/facts");
  });

  it("导出的 hash 阶段：服务端报错时抛 ApiError", async () => {
    stubFetch(() => new Response("炸了", { status: 500 }));
    await expect(ipc.boardPackFacts({ task_dirs: [], files: [] })).rejects.toBeInstanceOf(ApiError);
  });

  it("导出下载：响应体即 zip 流，给出任务目录数与字节数", async () => {
    stubFetch(() => new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 }));
    const result = await ipc.boardPackExport("a.ugcpack", { version: "1.0", board_file: "a.ugcboard.json", task_dirs: ["/~/任务"], files: [] } as never);
    expect(result.task_dirs).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("上传画板包：请求体是文件本身，回包给出包 id", async () => {
    const seen = stubFetch(() => new Response(JSON.stringify({ id: "pack-1" }), { status: 200 }));
    const id = await packUpload.upload(new File(["x"], "a.ugcpack"));
    expect(id).toBe("pack-1");
    expect(seen[0]).toContain("/api/packs/uploads");
  });

  it("上传画板包：服务端报错时抛 ApiError", async () => {
    stubFetch(() => new Response("炸了", { status: 500 }));
    await expect(packUpload.upload(new File(["x"], "a.ugcpack"))).rejects.toBeInstanceOf(ApiError);
  });

  it("进度轮询：没有在途请求时不问服务端", async () => {
    const seen = stubFetch(() => new Response(JSON.stringify({ done: 1, total: 2 }), { status: 200 }));
    const got: { done: number; total: number }[] = [];
    const stop = await browser.onPackProgress((p: { done: number; total: number }) => got.push(p));
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(got).toEqual([]);
    expect(seen).toEqual([]);
  });
});
