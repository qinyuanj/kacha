// 工作台动作的判定（#137）：运行的分派、重新生成、提交与复制。
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { Board } from "../core/board";
import { openRunConfirm, regenerate, startRun, type RegenerateDeps } from "./appActions";

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

  it("没有密钥：没有任务可跑时先说任务（还没到要密钥那步）", async () => {
    const toast = vi.fn();
    const openSettings = vi.fn();
    const startRun = vi.fn();
    await openRunConfirm({ activeKey: "k1", userRoot: "/~", hasApiKey: false, board: board(), locked: new Set(), selectedIds: [], ctx, startRun, toast, openSettings, confirm: vi.fn() });
    expect(toast).toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
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
