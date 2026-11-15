// 内存壳端口的各个分组（#137）：导入结局与画板存储。
import { describe, expect, it } from "vitest";
import { fakeBoardStore, fakeFileStore, fakePackStore, toImportResult } from "./fakePortStores";
import { emptyFakeCalls } from "./fakePort";
import type { FakeBoard } from "./fakePortTypes";

describe("导入结局", () => {
  it("done：原样带出", () => {
    const result = toImportResult({ kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入" }, written: ["/~/a"] });
    expect(result.kind).toBe("done");
  });

  it("partial：折成 done", () => {
    const result = toImportResult({ kind: "partial", message: "部分导入", conflicts: ["a"] });
    expect(result.kind).toBe("done");
  });

  it("failed：折成 commitFailed", () => {
    const result = toImportResult({ kind: "failed", error: "写不进去" });
    expect(result.kind).toBe("commitFailed");
  });

  it("slotsFull：折成 slotsFull", () => {
    expect(toImportResult({ kind: "slotsFull", message: "画板位满了" }).kind).toBe("slotsFull");
  });

  it("corrupt：折成 corrupt", () => {
    expect(toImportResult({ kind: "corrupt", reason: "坏了" }).kind).toBe("corrupt");
  });

  it("newer：折成 newer", () => {
    expect(toImportResult({ kind: "newer", message: "版本太新" }).kind).toBe("newer");
  });

  it("cancelled：折成 cancelled", () => {
    expect(toImportResult({ kind: "cancelled" }).kind).toBe("cancelled");
  });
});

describe("画板存储", () => {
  it("写入：记下调用并存下内容", async () => {
    const calls = emptyFakeCalls();
    const boards = new Map<string, FakeBoard>();
    const store = fakeBoardStore(boards, calls, {});
    await store.write("/~/a.ugcboard.json", "{}", { createOnly: true });
    expect(calls.write).toHaveLength(1);
    expect(boards.get("/~/a.ugcboard.json")?.main).toBe("{}");
  });

  it("只新建：已存在就拒绝", async () => {
    const calls = emptyFakeCalls();
    const boards = new Map<string, FakeBoard>([["/~/a.ugcboard.json", { path: "/~/a.ugcboard.json", main: "{}", version: "v1" }]]);
    const store = fakeBoardStore(boards, calls, {});
    await expect(store.write("/~/a.ugcboard.json", "{}", { createOnly: true })).rejects.toThrow();
  });

  it("版本不符：冲突", async () => {
    const calls = emptyFakeCalls();
    const boards = new Map<string, FakeBoard>([["/~/a.ugcboard.json", { path: "/~/a.ugcboard.json", main: "{}", version: "v1" }]]);
    const store = fakeBoardStore(boards, calls, {});
    await expect(store.write("/~/a.ugcboard.json", "{}", { version: "v2" })).rejects.toThrow();
  });

  it("删除不存在的：拒绝", async () => {
    const calls = emptyFakeCalls();
    const store = fakeBoardStore(new Map(), calls, {});
    await expect(store.remove("/~/a")).rejects.toThrow();
  });
});

describe("文件存储与真实适配器同形（B3）", () => {
  it("读不存在的文件：报 missing，不返回空数组", async () => {
    const store = fakeFileStore(new Map(), emptyFakeCalls());
    await expect(store.readFile("/~/不存在.png")).rejects.toMatchObject({ kind: "missing" });
  });

  it("列不存在的目录：报 missing，不返回空表", async () => {
    const store = fakeFileStore(new Map(), emptyFakeCalls());
    await expect(store.listDir("/~/不存在")).rejects.toMatchObject({ kind: "missing" });
  });

  it("存在的文件能读到字节、isFile 为真、listDir 能看到它", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const store = fakeFileStore(new Map(), emptyFakeCalls(), { files: { "/~/参考/cat.png": bytes } });
    await expect(store.readFile("/~/参考/cat.png")).resolves.toEqual(bytes);
    await expect(store.isFile("/~/参考/cat.png")).resolves.toBe(true);
    await expect(store.listDir("/~/参考")).resolves.toEqual([{ name: "cat.png", is_dir: false }]);
  });
});

describe("画板包存储", () => {
  it("没有脚本的结局：回 done", async () => {
    const calls = emptyFakeCalls();
    const store = fakePackStore([], calls);
    const result = await store.import(new File(["x"], "a.ugcpack"), { file: new File(["x"], "a.ugcpack"), openBoard: async () => undefined, slotsRefusal: async () => null, onStage: () => undefined, onPhase: () => undefined, log: () => undefined });
    expect(result.kind).toBe("done");
  });

  it("结局不是 done：原样返回", async () => {
    const calls = emptyFakeCalls();
    const store = fakePackStore([{ kind: "slotsFull", message: "画板位满了" }], calls);
    const result = await store.import(new File(["x"], "a.ugcpack"), { file: new File(["x"], "a.ugcpack"), openBoard: async () => undefined, slotsRefusal: async () => null, onStage: () => undefined, onPhase: () => undefined, log: () => undefined });
    expect(result.kind).toBe("slotsFull");
  });
  it("导入：记下调用并按结局返回", async () => {
    const calls = emptyFakeCalls();
    const store = fakePackStore([{ kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入" }, written: [] }], calls);
    const result = await store.import(new File(["x"], "a.ugcpack"), { file: new File(["x"], "a.ugcpack"), openBoard: async () => undefined, slotsRefusal: async () => null, onStage: () => undefined, onPhase: () => undefined, log: () => undefined });
    expect(result.kind).toBe("done");
    expect(calls.import).toHaveLength(1);
  });

  it("导入：打开画板失败记进 writeError", async () => {
    const calls = emptyFakeCalls();
    const store = fakePackStore([{ kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入" }, written: ["/~/a"] }], calls);
    const result = await store.import(new File(["x"], "a.ugcpack"), {
      file: new File(["x"], "a.ugcpack"),
      openBoard: async () => {
        throw new Error("打不开");
      },
      slotsRefusal: async () => null,
      onStage: () => undefined,
      onPhase: () => undefined,
      log: () => undefined,
    });
    expect(result.kind).toBe("done");
    if (result.kind === "done") expect(result.writeError).toContain("打不开");
  });
});