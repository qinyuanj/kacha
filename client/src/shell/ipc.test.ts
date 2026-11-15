// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiError";
import { browser, ipc, packContent, packUpload } from "./ipc";

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
    // jsdom 的 createObjectURL 只认自己造的 Blob，而 Response.blob() 给的是 Node 的 Blob：
    // 这里替掉它，断言的是「下载被触发、字节数被带出」，不依赖 jsdom 的版本。
    const created: (Blob | MediaSource)[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
      created.push(obj);
      return "blob:导出";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const result = await ipc.boardPackExport("a.ugcpack", { version: "1.0", board_file: "a.ugcboard.json", task_dirs: ["/~/任务"], files: [] } as never);
    expect(result.task_dirs).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(created).toHaveLength(1);
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

describe("画板包的内容接口", () => {
  /** 替掉 Worker：立刻回一条消息。 */
  function stubWorker(reply: (request: unknown) => unknown): void {
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: { message: string }) => void) | null = null;
        postMessage(request: unknown): void {
          queueMicrotask(() => this.onmessage?.({ data: reply(request) } as MessageEvent));
        }
        terminate(): void {}
      },
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it("比对服务端已有的目录：问服务端", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await packContent.existing([]);
    expect(seen[0]).toContain("/api/packs/existing");
  });

  it("建暂存目录：问服务端要目录 id", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ id: "staging-1" }), { status: 200 });
    });
    const id = await packContent.stage();
    expect(id).toBe("staging-1");
    expect(seen[0]).toContain("/api/packs/staging");
  });

  it("Worker 回了消息：把内容发给服务端", async () => {
    stubWorker(() => ({ kind: "body", body: new Blob(["x"]) }));
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response(null, { status: 200 });
    });
    await packContent.uploadContent("staging-1", "sha", { file: new File(["x"], "a.ugcpack"), entry: { path: "a.txt", method: 1, offset: 0, size: 1 } } as never, { done: 0, total: 1 });
    expect(seen[0]).toContain("/api/packs/staging/staging-1/contents/sha");
  });

  it("服务端出错时抛 ApiError", async () => {
    vi.stubGlobal("fetch", async () => new Response("炸了", { status: 500 }));
    await expect(packContent.stage()).rejects.toBeInstanceOf(ApiError);
  });
});