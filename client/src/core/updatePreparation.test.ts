import { describe, expect, it } from "vitest";
import { BUSY_MESSAGE, UNSAVED_MESSAGE, createUpdatePreparation, type UpdatePreparationPorts } from "./updatePreparation";

/** 记录提交守护的安装与解除：产品里没有测试专用访问器，只能从端口这一侧看。 */
function harness(overrides: Partial<UpdatePreparationPorts> = {}) {
  let pending = 0;
  let guard: (() => void) | null = null;
  const guardChanges: boolean[] = [];
  const saves = { boards: 0, ui: 0 };
  const ports: UpdatePreparationPorts = {
    queue: {
      pending: () => pending,
      setSubmissionGuard(next) {
        guard = next;
        guardChanges.push(next !== null);
      },
    },
    async saveBoards() {
      saves.boards++;
    },
    async saveUi() {
      saves.ui++;
    },
    unsavedChanges: () => false,
    ...overrides,
  };
  return {
    preparation: createUpdatePreparation(ports),
    saves,
    guardChanges,
    setPending(n: number) {
      pending = n;
    },
    guardInstalled: () => guard !== null,
  };
}

describe("更新准备：任务保护", () => {
  it("有未完成任务时拒绝，并给出「任务结束后可更新」", async () => {
    const h = harness();
    h.setPending(2);
    expect(await h.preparation.prepare()).toEqual({ ok: false, reason: BUSY_MESSAGE });
    expect(h.saves.boards).toBe(0);
    expect(h.guardInstalled()).toBe(false);
  });

  it("画板落盘失败：解除保护，说清失败的是哪一块", async () => {
    const h = harness({
      async saveBoards() {
        throw new Error("磁盘已满");
      },
    });
    expect(await h.preparation.prepare()).toEqual({ ok: false, reason: "保存画板失败：磁盘已满" });
    expect(h.guardInstalled()).toBe(false);
    expect(h.guardChanges).toEqual([true, false]);
  });

  it("界面状态落盘失败：同样解除保护", async () => {
    const h = harness({
      async saveUi() {
        throw new Error("设置文件坏了");
      },
    });
    expect(await h.preparation.prepare()).toEqual({ ok: false, reason: "保存界面状态失败：设置文件坏了" });
    expect(h.guardInstalled()).toBe(false);
  });

  it("写盘没抛错但仍有改动没保存成功：拒绝，不说成已保存（#180）", async () => {
    let unsaved = true;
    const h = harness({ unsavedChanges: () => unsaved });
    expect(await h.preparation.prepare()).toEqual({ ok: false, reason: UNSAVED_MESSAGE });
    expect(h.guardInstalled()).toBe(false);
    unsaved = false;
    expect(await h.preparation.prepare()).toEqual({ ok: true });
  });

  it("准备期间挡住新提交，release 之后恢复", async () => {
    const h = harness();
    expect(await h.preparation.prepare()).toEqual({ ok: true });
    expect(h.guardInstalled()).toBe(true);
    h.preparation.release();
    expect(h.guardInstalled()).toBe(false);
    expect(h.guardChanges).toEqual([true, false]);
  });

  it("重复点安装只准备一次、只保存一次", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.preparation.prepare(), h.preparation.prepare()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(h.saves).toEqual({ boards: 1, ui: 1 });
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

  it("准备失败时不放行安装", async () => {
    const h = harness({
      async saveBoards() {
        throw new Error("磁盘已满");
      },
    });
    expect(await h.preparation.installGuard()).toEqual({ allowed: false, reason: "保存画板失败：磁盘已满" });
  });
});
