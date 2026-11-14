// 工作台动作的判定（#137）：运行的分派、重新生成、提交与复制。
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { Board } from "../core/board";
import { applyRunDecision, archiveBoardAt, deleteBoardAt, exportableKey, openRunConfirm, regenerate, startRun, type RegenerateDeps, type RunDeps } from "./appActions";

const board = (): Board => ({ format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });

const ctx = { table: BUILTIN_TABLE, discovery: { source: "none" as const }, concurrency: 2, probe: { inspectImage: async () => ({ has_alpha: false }) } };

describe("运行的分派", () => {
  it("没有画板：什么都不做", async () => {
    const toast = vi.fn();
    await openRunConfirm({ activeKey: null, userRoot: "/~", hasApiKey: true, board: null, locked: new Set(), selectedIds: [], ctx, startRun: vi.fn(), toast, openSettings: vi.fn(), confirm: vi.fn() });
    expect(toast).not.toHaveBeenCalled();
  });

  it("没有任务可跑：提示一句，不提交也不弹窗", async () => {
    const toast = vi.fn();
    const startRun = vi.fn();
    const confirm = vi.fn();
    await openRunConfirm({ activeKey: "k1", userRoot: "/~", hasApiKey: true, board: board(), locked: new Set(), selectedIds: [], ctx, startRun, toast, openSettings: vi.fn(), confirm });
    expect(toast).toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("没有密钥：先说没有可运行的任务（还没到要密钥那步）", async () => {
    const toast = vi.fn();
    const openSettings = vi.fn();
    const startRun = vi.fn();
    await openRunConfirm({ activeKey: "k1", userRoot: "/~", hasApiKey: false, board: board(), locked: new Set(), selectedIds: [], ctx, startRun, toast, openSettings, confirm: vi.fn() });
    expect(toast).toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });
});

describe("运行的分派结果", () => {
  const deps = (): RunDeps => ({
    activeKey: "k1",
    userRoot: "/~",
    hasApiKey: true,
    board: board(),
    locked: new Set(),
    selectedIds: [],
    ctx,
    startRun: vi.fn(),
    toast: vi.fn(),
    openSettings: vi.fn(),
    confirm: vi.fn(),
  });

  it("toast：给一句说明", () => {
    const d = deps();
    applyRunDecision(d, board(), { kind: "toast", message: "没有可运行的任务" });
    expect(d.toast).toHaveBeenCalledWith("没有可运行的任务");
  });

  it("needKey：提示并打开高级设置", () => {
    const d = deps();
    applyRunDecision(d, board(), { kind: "needKey" });
    expect(d.openSettings).toHaveBeenCalled();
  });

  it("submit：直接提交", () => {
    const d = deps();
    applyRunDecision(d, board(), { kind: "submit", taskId: "t1" });
    expect(d.startRun).toHaveBeenCalledWith("k1", expect.anything(), ["t1"]);
  });

  it("confirm：弹二次确认", () => {
    const d = deps();
    const items = [{ taskId: "t1", modelName: "m", firstLine: "x", send: null, reasons: [], warnings: [] }];
    applyRunDecision(d, board(), { kind: "confirm", items, scope: "selection" });
    expect(d.confirm).toHaveBeenCalledWith("k1", expect.anything(), items, "selection");
  });
});

describe("重新生成", () => {
  function deps(patch: Partial<RegenerateDeps> = {}): RegenerateDeps {
    return {
      activeKey: "k1",
      userRoot: "/~",
      hasApiKey: true,
      board: board(),
      ctx,
      ask: async () => true,
      regenerate: async () => null,
      targetOf: () => ({ boardKey: "k1", boardFile: "a.ugcboard.json", table: BUILTIN_TABLE, userRoot: "/~", baseUrl: "http://gw", apiKey: "sk" }),
      toast: vi.fn(),
      openSettings: vi.fn(),
      ...patch,
    };
  }

  it("没有画板：什么都不做", async () => {
    const regenerateFn = vi.fn(async () => null);
    await regenerate(deps({ board: null, regenerate: regenerateFn }), "t1");
    expect(regenerateFn).not.toHaveBeenCalled();
  });

  it("没有密钥：提示并打开高级设置", async () => {
    const openSettings = vi.fn();
    await regenerate(deps({ hasApiKey: false, openSettings }), "t1");
    expect(openSettings).toHaveBeenCalled();
  });

  it("生成变体：固定一份，不确认", async () => {
    const ask = vi.fn(async () => true);
    const regenerateFn = vi.fn(async () => null);
    await regenerate(deps({ ask, regenerate: regenerateFn }), "t1", "parent");
    expect(ask).not.toHaveBeenCalled();
    expect(regenerateFn).toHaveBeenCalled();
  });

  it("失败：给出提示", async () => {
    const toast = vi.fn();
    await regenerate(deps({ toast, regenerate: async () => "网关不可达" }), "t1", "parent");
    expect(toast).toHaveBeenCalled();
  });
});

describe("提交一次运行", () => {
  it("成功：没有问题就不提示", async () => {
    const toast = vi.fn();
    await startRun({ userRoot: "/~", target: { boardKey: "k1", boardFile: "a", table: BUILTIN_TABLE, userRoot: "/~", baseUrl: "http://gw", apiKey: "sk" }, concurrency: 2, submit: async () => [], toast }, board(), ["t1"]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("有提交失败的：给出提示", async () => {
    const toast = vi.fn();
    await startRun({ userRoot: "/~", target: { boardKey: "k1", boardFile: "a", table: BUILTIN_TABLE, userRoot: "/~", baseUrl: "http://gw", apiKey: "sk" }, concurrency: 2, submit: async () => ["网关不可达"], toast }, board(), ["t1"]);
    expect(toast).toHaveBeenCalled();
  });

  it("没有用户数据根：不提交", async () => {
    const submit = vi.fn(async () => []);
    await startRun({ userRoot: null, target: { boardKey: "k1", boardFile: "a", table: BUILTIN_TABLE, userRoot: "/~", baseUrl: "http://gw", apiKey: "sk" }, concurrency: 2, submit, toast: vi.fn() }, board(), ["t1"]);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("画板列表的删除与归档", () => {
  it("删除：没打开的画板直接删", async () => {
    const removeDirect = vi.fn(async () => undefined);
    await deleteBoardAt({ keyOf: () => null, pending: () => 0, ask: async () => true, closeRunner: vi.fn(), deleteSessions: vi.fn(async () => undefined), removeDirect }, "/~/a");
    expect(removeDirect).toHaveBeenCalledWith("/~/a");
  });

  it("删除：打开的先停任务再删", async () => {
    const closeRunner = vi.fn();
    const deleteSessions = vi.fn(async () => undefined);
    await deleteBoardAt({ keyOf: () => "k1", pending: () => 2, ask: async () => true, closeRunner, deleteSessions, removeDirect: vi.fn(async () => undefined) }, "/~/a");
    expect(closeRunner).toHaveBeenCalledWith("k1");
    expect(deleteSessions).toHaveBeenCalledWith("k1");
  });

  it("删除：用户不放弃就不删", async () => {
    const deleteSessions = vi.fn(async () => undefined);
    await deleteBoardAt({ keyOf: () => "k1", pending: () => 2, ask: async () => false, closeRunner: vi.fn(), deleteSessions, removeDirect: vi.fn(async () => undefined) }, "/~/a");
    expect(deleteSessions).not.toHaveBeenCalled();
  });

  it("归档：打开的先停任务再归档", async () => {
    const closeRunner = vi.fn();
    const archiveSessions = vi.fn(async () => undefined);
    await archiveBoardAt({ keyOf: () => "k1", pending: () => 1, ask: async () => true, closeRunner, archiveSessions }, "/~/a");
    expect(closeRunner).toHaveBeenCalledWith("k1");
    expect(archiveSessions).toHaveBeenCalledWith("/~/a");
  });

  it("归档：没打开的直接归档", async () => {
    const closeRunner = vi.fn();
    const archiveSessions = vi.fn(async () => undefined);
    await archiveBoardAt({ keyOf: () => null, pending: () => 0, ask: async () => true, closeRunner, archiveSessions }, "/~/a");
    expect(closeRunner).not.toHaveBeenCalled();
    expect(archiveSessions).toHaveBeenCalledWith("/~/a");
  });
});

describe("导出前的画板 key", () => {
  it("已经打开：直接用那个 key", async () => {
    const key = await exportableKey({ keyOf: () => "k1", open: vi.fn(async () => true), toast: vi.fn() }, "/~/a");
    expect(key).toBe("k1");
  });

  it("没打开：先打开", async () => {
    const open = vi.fn(async () => true);
    const key = await exportableKey({ keyOf: () => (open.mock.calls.length ? "k1" : null), open, toast: vi.fn() }, "/~/a");
    expect(open).toHaveBeenCalledWith("/~/a", true);
    expect(key).toBe("k1");
  });

  it("打不开：给提示，没有 key", async () => {
    const toast = vi.fn();
    const key = await exportableKey({ keyOf: () => null, open: vi.fn(async () => false), toast }, "/~/a");
    expect(key).toBeNull();
    expect(toast).toHaveBeenCalled();
  });
});