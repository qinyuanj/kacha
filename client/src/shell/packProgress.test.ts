// 画板包进度轮询（#137）：本地进度优先、只在操作在途时问服务端、停用后不再问。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackProgress, type PackProgress, type PackProgressSource } from "./packProgress";

afterEach(() => vi.useRealTimers());

interface Harness {
  source: PackProgressSource;
  handler: ReturnType<typeof vi.fn<(progress: PackProgress) => void>>;
  asked: string[];
}

function harness(patch: Partial<PackProgressSource> = {}): Harness {
  const asked: string[] = [];
  const source: PackProgressSource = {
    currentOp: () => "op-1",
    busy: () => true,
    localProgress: () => undefined,
    fetchProgress: async (op) => {
      asked.push(op);
      return { done: 3, total: 9 };
    },
    ...patch,
  };
  return { source, handler: vi.fn<(progress: PackProgress) => void>(), asked };
}

describe("画板包进度", () => {
  it("操作在途时问服务端并报进度", async () => {
    const h = harness();
    const stop = createPackProgress(h.source, h.handler, 1000);
    await vi.waitFor(() => expect(h.handler).toHaveBeenCalledWith({ done: 3, total: 9 }));
    expect(h.asked).toEqual(["op-1"]);
    stop();
  });

  it("本地阶段有进度时直接报它，不问服务端", async () => {
    const h = harness({ localProgress: () => ({ done: 1, total: 8 }) });
    const stop = createPackProgress(h.source, h.handler, 1000);
    await vi.waitFor(() => expect(h.handler).toHaveBeenCalledWith({ done: 1, total: 8 }));
    expect(h.asked).toEqual([]);
    stop();
  });

  it("没有进行中的操作：不问服务端", async () => {
    const h = harness({ currentOp: () => null });
    const stop = createPackProgress(h.source, h.handler, 1000);
    await Promise.resolve();
    expect(h.asked).toEqual([]);
    expect(h.handler).not.toHaveBeenCalled();
    stop();
  });

  it("操作不在途（本地阶段结束、服务端还没进度）：不问", async () => {
    const h = harness({ busy: () => false });
    const stop = createPackProgress(h.source, h.handler, 1000);
    await Promise.resolve();
    expect(h.asked).toEqual([]);
    stop();
  });

  it("服务端读不到进度：不报", async () => {
    const h = harness({ fetchProgress: async () => null });
    const stop = createPackProgress(h.source, h.handler, 1000);
    await vi.waitFor(() => expect(h.handler).not.toHaveBeenCalled());
    // 问过了但没有进度可报：界面继续显示上一次的进度。
    expect(h.handler).not.toHaveBeenCalled();
    stop();
  });

  it("停用之后不再问服务端", async () => {
    vi.useFakeTimers();
    const h = harness();
    const stop = createPackProgress(h.source, h.handler, 100);
    // 停用前的那一次（启动即问一次）算数，之后不再问。
    await vi.advanceTimersByTimeAsync(1);
    const askedBefore = h.asked.length;
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.asked.length).toBe(askedBefore);
  });
});
