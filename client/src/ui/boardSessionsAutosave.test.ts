// 多画板会话的去抖自动保存（#137）：落盘时机、写入条件与写失败。
import { describe, expect, it, vi } from "vitest";
import { flushPending, noteSaveFailure, unsavedChanges, writableNow, writeSession, type Saver } from "./boardSessionsAutosave";
import type { OkSession, Session } from "./useBoardSessions";

const session = (patch: Partial<OkSession> = {}): OkSession =>
  ({
    key: "k1",
    path: "/~/a.ugcboard.json",
    status: "ok",
    board: { format_version: 2, title: "a", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} },
    history: { undo: [], redo: [], mergeable: null, seenResults: new Set() },
    notice: null,
    saveError: null,
    version: "v1",
    conflicted: false,
    missing: false,
    ...patch,
  }) as unknown as OkSession;

/** 有计时器/没有计时器的保存器：只看判定，不真写盘。 */
const saverWith = (timer: Saver["timer"]): Saver => ({ timer, chain: Promise.resolve() });

describe("有没有未保存的改动（#180）", () => {
  it("没有失败也没有待写计时器：算保存好了", () => {
    expect(unsavedChanges([session()], new Map())).toBe(false);
  });

  it("上一次写盘失败：算没保存", () => {
    expect(unsavedChanges([session({ saveError: "写不进去" })], new Map())).toBe(true);
  });

  it("还在等去抖计时器：算没保存", () => {
    const savers = new Map<string, Saver>([["k1", saverWith(1 as unknown as ReturnType<typeof setTimeout>)]]);
    expect(unsavedChanges([session()], savers)).toBe(true);
  });

  it("计时器已经跑过（null）：算保存好了", () => {
    const savers = new Map<string, Saver>([["k1", saverWith(null)]]);
    expect(unsavedChanges([session()], savers)).toBe(false);
  });

  it("打不开的会话（太新 / 损坏）：不算未保存", () => {
    const newer = { key: "k2", path: "/~/b.ugcboard.json", status: "newer", version: 9 } as unknown as Session;
    expect(unsavedChanges([newer], new Map())).toBe(false);
  });
});

describe("落盘待写的改动", () => {
  it("有待写计时器：立刻落盘", async () => {
    const flush = vi.fn(async () => undefined);
    const saver: Saver = { timer: setTimeout(() => undefined, 10_000), chain: Promise.resolve() };
    await flushPending("k1", () => saver, flush);
    expect(flush).toHaveBeenCalledWith("k1");
  });

  it("没有计时器：等之前的写完", async () => {
    const flush = vi.fn(async () => undefined);
    const saver: Saver = { timer: null, chain: Promise.resolve() };
    await flushPending("k1", () => saver, flush);
    expect(flush).not.toHaveBeenCalled();
  });

  it("没有保存器：什么都不做", async () => {
    const flush = vi.fn(async () => undefined);
    await flushPending("k1", () => undefined as never, flush);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("这一轮要不要写", () => {
  it("普通画板：写", () => {
    expect(writableNow(session(), () => false)).toBe(true);
  });

  it("冲突的画板：不写", () => {
    expect(writableNow(session({ conflicted: true }), () => false)).toBe(false);
  });

  it("归档的画板：不写", () => {
    expect(writableNow(session(), () => true)).toBe(false);
  });

  it("会话不在：不写", () => {
    expect(writableNow(undefined, () => false)).toBe(false);
  });
});

describe("写入", () => {
  it("写成功：回写新版本", async () => {
    const write = vi.fn(async () => undefined);
    const patch = vi.fn();
    await writeSession({ board: { write } } as never, patch, "k1", session());
    expect(write).toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
  });

  it("新建的画板：只新建不覆盖", async () => {
    const seen: unknown[] = [];
    const write = vi.fn(async (_path: string, _text: string, options?: { createOnly?: boolean }) => {
      seen.push(options);
    });
    await writeSession({ board: { write } } as never, vi.fn(), "k1", session({ version: null }));
    expect(seen[0]).toEqual({ createOnly: true });
  });
});

describe("写失败", () => {
  it("记下错误并写日志", () => {
    const patch = vi.fn();
    const log = vi.fn();
    noteSaveFailure(patch, { ui: { log } }, "k1", session(), new Error("offline"));
    expect(log).toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
  });
});