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
