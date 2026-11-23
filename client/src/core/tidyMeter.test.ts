import { expect, it } from "vitest";
import { TidyMeter, type TidyMeasurement } from "./tidyMeter";
import type { BoardMeasure } from "./tidy";

it("入场响应晚于删节点后的测量时，仍对比入场体量与当前体量", async () => {
  const pending = new Map<string, (m: BoardMeasure) => void>();
  let state: TidyMeasurement = { measure: null, before: null };
  const meter = new TidyMeter("before", (text) => new Promise((resolve) => pending.set(text, resolve)), (value) => { state = value; });
  meter.update("before");
  meter.update("after");
  pending.get("after")!({ nodes: {}, dirs: { kept: 20 } });
  await Promise.resolve();
  pending.get("before")!({ nodes: {}, dirs: { kept: 20, removed: 80 } });
  await Promise.resolve();
  expect(state.before).toBe(100);
  expect(state.measure?.dirs).toEqual({ kept: 20 });
  meter.dispose();
});

it("退出整理后旧响应不会覆盖新一轮状态", async () => {
  let resolve!: (m: BoardMeasure) => void;
  let changed = false;
  const meter = new TidyMeter("old", () => new Promise((r) => { resolve = r; }), () => { changed = true; });
  meter.update("old");
  meter.dispose();
  resolve({ nodes: {}, dirs: { old: 100 } });
  await Promise.resolve();
  expect(changed).toBe(false);
});

it("量失败：明说量不出来，不沿用上一份数当 0", async () => {
  const measures = new Map<string, { resolve: (m: BoardMeasure) => void; reject: (e: unknown) => void }>();
  let state: TidyMeasurement = { measure: null, before: null };
  const meter = new TidyMeter("first", (text) => {
    const pending = {} as { resolve: (m: BoardMeasure) => void; reject: (e: unknown) => void };
    const promise = new Promise<BoardMeasure>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    measures.set(text, pending);
    return promise;
  }, (value) => { state = value; });

  meter.update("first");
  measures.get("first")!.resolve({ nodes: {}, dirs: { kept: 100 } });
  await Promise.resolve();
  expect(state.measure).toEqual({ nodes: {}, dirs: { kept: 100 } });

  meter.update("broken");
  measures.get("broken")!.reject(new Error("读不懂这块画板"));
  await Promise.resolve();
  expect(state.measure).toBeNull();
  expect(state.failed).toBe(true);
  meter.dispose();
});

it("量成功之后 cleared failed：恢复后不再显示未知", async () => {
  let fail!: (e: unknown) => void;
  let state: TidyMeasurement = { measure: null, before: null };
  let call = 0;
  const meter = new TidyMeter("text", () => {
    call += 1;
    if (call === 1) return Promise.resolve({ nodes: {}, dirs: { kept: 10 } });
    if (call === 2) return new Promise<BoardMeasure>((_resolve, reject) => { fail = reject; });
    return Promise.resolve({ nodes: {}, dirs: { kept: 20 } });
  }, (value) => { state = value; });

  meter.update("text");
  await Promise.resolve();
  meter.update("broken");
  fail(new Error("读盘失败"));
  await Promise.resolve();
  expect(state.failed).toBe(true);

  meter.update("next");
  await Promise.resolve();
  expect(state.failed).toBe(false);
  expect(state.measure).toEqual({ nodes: {}, dirs: { kept: 20 } });
  meter.dispose();
});
