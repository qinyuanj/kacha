import { describe, expect, it } from "vitest";
import { BUSY_MESSAGE, UNSAVED_MESSAGE, createUpdatePreparation, type UpdatePreparationPorts } from "./updatePreparation";

/** 一个可编排的队列与保存器：测试要控制「有没有任务」「保存成不成功」。 */
function harness(overrides: Partial<UpdatePreparationPorts> = {}) {
  let pending = 0;
  let unsaved = false;
  let guard: (() => void) | null = null;
  const blocked: string[] = [];
  const saves = { boards: 0, ui: 0 };
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
    unsavedChanges: () => unsaved,
    ...overrides,
  };
  const preparation = createUpdatePreparation(ports);
  return {
    preparation,
    blocked,
    saves,
    setPending(n: number) {
      pending = n;
    },
    /** 模拟「写盘调用没抛错，但会话上还留着没保存的改动」。 */
    setUnsaved(next: boolean) {
      unsaved = next;
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

  it("准备期间拒绝新提交，release 后恢复", async () => {
    const h = harness();
    expect(h.submit()).toBe(true);
    const result = await h.preparation.prepare();
    expect(result.ok).toBe(true);
    expect(h.guarded()).toBe(true);
    expect(h.submit()).toBe(false);
    h.preparation.release();
    expect(h.guarded()).toBe(false);
    expect(h.submit()).toBe(true);
  });
});

describe("更新准备：保存", () => {
  it("准备失败时解除保护，恢复正常操作", async () => {
    const h = harness({
      async saveBoards() {
        throw new Error("磁盘已满");
      },
    });
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: false, reason: "保存画板失败：磁盘已满" });
    expect(h.guarded()).toBe(false);
    expect(h.submit()).toBe(true);
  });

  it("写盘没抛错但仍有改动没保存成功：拒绝，不说成已保存（#180）", async () => {
    const h = harness();
    h.setUnsaved(true);
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: false, reason: UNSAVED_MESSAGE });
    // 改动落盘之后又恢复：准备回到通过。
    h.setUnsaved(false);
    expect(await h.preparation.prepare()).toEqual({ ok: true });
  });

  it("保存界面状态失败也拒绝，且不改口说成功", async () => {
    const h = harness({
      async saveUi() {
        throw new Error("权限不足");
      },
    });
    const result = await h.preparation.prepare();
    expect(result).toEqual({ ok: false, reason: "保存界面状态失败：权限不足" });
    expect(h.guarded()).toBe(false);
  });

  it("重复点安装只准备一次、只保存一次", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.preparation.prepare(), h.preparation.prepare()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(h.saves.boards).toBe(1);
    expect(h.saves.ui).toBe(1);
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
