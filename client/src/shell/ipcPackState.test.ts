// 画板包操作状态（#137）：操作 id 的分配与隔离、取消标记、在途计数、中止信号与本地进度。
import { describe, expect, it } from "vitest";
import { createPackOpState } from "./ipcPackState";

describe("画板包操作状态", () => {
  it("没有操作时当前 id 为 null", () => {
    const ops = createPackOpState();
    expect(ops.currentOp()).toBeNull();
  });

  it("开始一次操作后拿到 id；再开始换一个新 id", () => {
    const ops = createPackOpState();
    const first = ops.begin();
    expect(ops.currentOp()).toBe(first);
    const second = ops.begin();
    expect(second).not.toBe(first);
    expect(ops.currentOp()).toBe(second);
  });

  it("取消只影响当前操作，之后的新操作不受影响", () => {
    const ops = createPackOpState();
    const first = ops.begin();
    expect(ops.cancel()).toBe(first);
    expect(ops.isCancelled(first)).toBe(true);
    const second = ops.begin();
    expect(ops.isCancelled(second)).toBe(false);
  });

  it("取消时中止在途请求的信号", () => {
    const ops = createPackOpState();
    const op = ops.begin();
    const signal = ops.signal(op);
    expect(signal.aborted).toBe(false);
    ops.cancel();
    expect(signal.aborted).toBe(true);
  });

  it("没有当前操作时取消返回 null", () => {
    const ops = createPackOpState();
    expect(ops.cancel()).toBeNull();
  });

  it("在途计数：最后一个请求走掉后不再在途", () => {
    const ops = createPackOpState();
    const op = ops.begin();
    expect(ops.busy(op)).toBe(false);
    ops.enter(op);
    ops.enter(op);
    expect(ops.busy(op)).toBe(true);
    ops.leave(op);
    expect(ops.busy(op)).toBe(true);
    ops.leave(op);
    expect(ops.busy(op)).toBe(false);
  });

  it("本地进度：记下、读出、清除", () => {
    const ops = createPackOpState();
    const op = ops.begin();
    expect(ops.localProgress(op)).toBeUndefined();
    ops.setLocalProgress(op, { done: 2, total: 8 });
    expect(ops.localProgress(op)).toEqual({ done: 2, total: 8 });
    ops.setLocalProgress(op, undefined);
    expect(ops.localProgress(op)).toBeUndefined();
  });

  it("同一个操作拿到同一个中止信号", () => {
    const ops = createPackOpState();
    const op = ops.begin();
    expect(ops.signal(op)).toBe(ops.signal(op));
  });
});
