import { describe, expect, it } from "vitest";
import { BUSY_MESSAGE, createUpdatePreparation, type UpdatePreparationPorts } from "./updatePreparation";

/** 一个可编排的队列与保存器：测试要控制「有没有任务」「保存成不成功」。 */
function harness(overrides: Partial<UpdatePreparationPorts> = {}) {
  let pending = 0;
  let guard: (() => void) | null = null;
  const blocked: string[] = [];
  const saves = { boards: 0, ui: 0 };
  const protection: boolean[] = [];
  const ports: UpdatePreparationPorts = {
    queue: {
      pending: () => pending,
      setSubmissionGuard(next) {
        guard = next;
      },
    },
    async saveBoards() {
      saves.boards++;
    },
    async saveUi() {
      saves.ui++;
    },
    onProtectionChange: (active) => protection.push(active),
    ...overrides,
  };
  const preparation = createUpdatePreparation(ports);
  return {
    preparation,
    blocked,
    saves,
    protection,
    setPending(n: number) {
      pending = n;
    },
    /** 模拟一次新提交：被守护时记一笔。 */
    submit() {
      if (guard) {
        guard();
        blocked.push("blocked");
        return false;
      }
      return true;
    },
    guarded: () => guard !== null,
  };
}

describe("更新准备：任务保护", () => {
  it("有未完成任务时拒绝，并给出「任务结束后可更新」", async () => {
    const h = harness();
    h.setPending(2);
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: false, reason: BUSY_MESSAGE });
    // 拒绝时不该保存，也不该挂保护。
    expect(h.saves.boards).toBe(0);
    expect(h.guarded()).toBe(false);
  });

  it("任务结束后不自动安装：准备通过也不等于安装", async () => {
    const h = harness();
    h.setPending(0);
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: true });
    // 保护仍在（等用户点安装），但没有任何「自动装」的动作。
    expect(h.preparation.active()).toBe(true);
  });
});

describe("更新准备：保护范围", () => {
  it("准备期间拒绝新提交，成功后保护保持到安装结束", async () => {
    const h = harness();
    expect(h.submit()).toBe(true);
    const result = await h.preparation.prepare();
    expect(result.ok).toBe(true);
    expect(h.guarded()).toBe(true);
    expect(h.submit()).toBe(false);
    expect(h.preparation.blocked()).toBe(true);
    h.preparation.release();
    expect(h.guarded()).toBe(false);
    expect(h.submit()).toBe(true);
  });

  it("保护开关变化会通知界面", async () => {
    const h = harness();
    await h.preparation.prepare();
    expect(h.protection).toEqual([true]);
    h.preparation.release();
    expect(h.protection).toEqual([true, false]);
  });

  it("准备失败时解除保护，恢复正常操作", async () => {
    const h = harness({
      async saveBoards() {
        throw new Error("磁盘已满");
      },
    });
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: false, reason: "保存画板失败：磁盘已满" });
    expect(h.preparation.active()).toBe(false);
    expect(h.guarded()).toBe(false);
    expect(h.submit()).toBe(true);
  });

  it("保存界面状态失败也拒绝，且不改口说成功", async () => {
    const h = harness({
      async saveUi() {
        throw new Error("权限不足");
      },
    });
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: false, reason: "保存界面状态失败：权限不足" });
    expect(h.preparation.active()).toBe(false);
  });
});

describe("更新准备：在途操作", () => {
  it("等在途操作结束再保存", async () => {
    const h = harness();
    // TS 不追踪执行器里的赋值：用一个对象装 resolve，避免被收窄成 null。
    const gate: { finish?: () => void } = {};
    const inFlight = new Promise<void>((resolve) => {
      gate.finish = resolve;
    });
    h.preparation.track(inFlight);
    const preparing = h.preparation.prepare();
    // 在途没结束时还不能保存。
    await Promise.resolve();
    expect(h.saves.boards).toBe(0);
    gate.finish?.();
    await preparing;
    expect(h.saves.boards).toBe(1);
    expect(h.saves.ui).toBe(1);
  });

  it("在途操作失败时准备失败并解除保护", async () => {
    const h = harness();
    const failing = Promise.reject(new Error("导入失败"));
    failing.catch(() => undefined);
    h.preparation.track(failing);
    const result = await h.preparation.prepare();
    expect(result.ok).toBe(false);
    expect(h.preparation.active()).toBe(false);
    expect(h.guarded()).toBe(false);
  });
});

describe("更新准备：并发与代次", () => {
  it("重复点安装只准备一次、只保存一次", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.preparation.prepare(), h.preparation.prepare()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(h.saves.boards).toBe(1);
    expect(h.saves.ui).toBe(1);
  });

  it("失败恢复后代次前进，旧异步操作不能再提交变更", async () => {
    const h = harness({
      async saveBoards() {
        throw new Error("写不进去");
      },
    });
    const before = h.preparation.generation();
    await h.preparation.prepare();
    expect(h.preparation.generation()).toBeGreaterThan(before);
  });
});

describe("更新准备：安装守卫", () => {
  it("准备通过才允许安装，失败时给原因", async () => {
    const ok = harness();
    expect(await ok.preparation.installGuard()).toEqual({ allowed: true });
    const busy = harness();
    busy.setPending(1);
    expect(await busy.preparation.installGuard()).toEqual({ allowed: false, reason: BUSY_MESSAGE });
  });
});
