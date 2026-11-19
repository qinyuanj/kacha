// 空闲自动安装的判定（#180）：倒计时、门控与「稍后」都是纯逻辑，这里不等真实时间。
import { describe, expect, it } from "vitest";
import { emptySnapshot, type UpdateSnapshot } from "./update";
import {
  AUTO_INSTALL_DELAY_MS,
  autoInstallText,
  autoInstallView,
  autoStep,
  createAutoInstall,
  IDLE_AUTO_VIEW,
  idleBlocker,
  INITIAL_AUTO_STATE,
  NOT_READY_MESSAGE,
  sameAutoInstallView,
  type AutoInstallInput,
  type AutoInstallState,
  type InstallOutcome,
} from "./updateAutoInstall";
import { BUSY_MESSAGE, UNSAVED_MESSAGE } from "./updatePreparation";

/** 已就绪且可装的快照：自动安装唯一会动手的阶段。 */
const ready = (overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  ...emptySnapshot(),
  phase: "ready",
  version: "1.6.2",
  verified: true,
  installable: true,
  downloaded: 100,
  total: 100,
  ...overrides,
});

/** 一次判定要看的输入；默认空闲、已读到快照。 */
const input = (overrides: Partial<AutoInstallInput> = {}): AutoInstallInput => ({
  snapshot: ready(),
  loaded: true,
  boardsReady: true,
  settingsLoaded: true,
  pendingTasks: 0,
  unsavedChanges: false,
  ...overrides,
});

const NOW = 1_000_000;

describe("空闲判定", () => {
  it("工作台载入完成、没有任务、没有未落盘的改动才算空闲", () => {
    expect(idleBlocker({ boardsReady: true, settingsLoaded: true, pendingTasks: 0, unsavedChanges: false })).toBe("");
  });

  it("有进行中的任务：说任务结束后可更新", () => {
    expect(idleBlocker({ boardsReady: true, settingsLoaded: true, pendingTasks: 3, unsavedChanges: false })).toBe(BUSY_MESSAGE);
  });

  it("有改动没落盘：说改动保存后再更新", () => {
    expect(idleBlocker({ boardsReady: true, settingsLoaded: true, pendingTasks: 0, unsavedChanges: true })).toBe(UNSAVED_MESSAGE);
  });

  it("任务与未落盘同时存在时先说任务", () => {
    expect(idleBlocker({ boardsReady: true, settingsLoaded: true, pendingTasks: 1, unsavedChanges: true })).toBe(BUSY_MESSAGE);
  });

  it("工作台还没载入完成：什么都不说，先等它", () => {
    // 启动时更新快照先到、画板列表还在读：这时装会把半载入的界面状态写回去（#180）。
    const loaded = { boardsReady: true, settingsLoaded: true, pendingTasks: 0, unsavedChanges: false };
    expect(idleBlocker({ ...loaded, boardsReady: false })).toBe(NOT_READY_MESSAGE);
    expect(idleBlocker({ ...loaded, settingsLoaded: false })).toBe(NOT_READY_MESSAGE);
    expect(idleBlocker({ ...loaded, boardsReady: false, settingsLoaded: false, pendingTasks: 2, unsavedChanges: true })).toBe(NOT_READY_MESSAGE);
  });
});

describe("自动安装：什么时候不动手", () => {
  it("工作台还没载入完成：先不装；载入完成后仍空闲就直接装（启动就绪不再倒计时）", () => {
    // 启动时快照先到、画板列表还在读：这时装会把半载入的界面状态写回去。
    const blocked = autoStep(INITIAL_AUTO_STATE, input({ boardsReady: false }), NOW);
    expect(blocked.install).toBe(false);
    expect(blocked.state.waiting).toBe(NOT_READY_MESSAGE);
    // 「启动就绪」的机会留给载入完成之后：仍空闲就直接装，不再倒计时。
    expect(blocked.state.startup).toBe("ready");
    const after = autoStep(blocked.state, input(), NOW + 1_000);
    expect(after.install).toBe(true);
    expect(after.state.startup).toBe("other");
  });

  it("还没读到真实快照：不判（空快照的 idle 不代表没更新）", () => {
    const step = autoStep(INITIAL_AUTO_STATE, input({ loaded: false, snapshot: emptySnapshot() }), NOW);
    expect(step).toEqual({ state: INITIAL_AUTO_STATE, install: false });
  });

  it("发现新版本（还没下载完）：清掉倒计时，不装", () => {
    const counting: AutoInstallState = { ...INITIAL_AUTO_STATE, startup: "other", deadline: NOW + 5_000 };
    const step = autoStep(counting, input({ snapshot: ready({ phase: "downloading" }) }), NOW);
    expect(step.install).toBe(false);
    expect(step.state.deadline).toBeNull();
  });

  it("没验签：即使阶段是 ready 也不装", () => {
    const step = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input({ snapshot: ready({ verified: false }) }), NOW);
    expect(step.install).toBe(false);
    expect(step.state.deadline).toBeNull();
  });

  it("用户点了稍后：本轮不再自动装，倒计时也停掉", () => {
    const deferred: AutoInstallState = { ...INITIAL_AUTO_STATE, startup: "other", deferred: true, deadline: NOW + 1 };
    const step = autoStep(deferred, input(), NOW + 10_000);
    expect(step.install).toBe(false);
    expect(step.state.deadline).toBeNull();
  });

  it("正在装：不重复交给安装器", () => {
    const installing: AutoInstallState = { ...INITIAL_AUTO_STATE, startup: "other", installing: true };
    expect(autoStep(installing, input(), NOW).install).toBe(false);
  });
});

describe("自动安装：任务与保存失败不打断", () => {
  it("有进行中的任务：不装，说明原因", () => {
    const step = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input({ pendingTasks: 2 }), NOW);
    expect(step.install).toBe(false);
    expect(step.state.waiting).toBe(BUSY_MESSAGE);
    expect(step.state.deadline).toBeNull();
  });

  it("倒计时中途来了任务：倒计时作废，等任务结束", () => {
    const counting: AutoInstallState = { ...INITIAL_AUTO_STATE, startup: "other", deadline: NOW + 10_000 };
    const step = autoStep(counting, input({ pendingTasks: 1 }), NOW + 5_000);
    expect(step.install).toBe(false);
    expect(step.state.deadline).toBeNull();
    expect(step.state.waiting).toBe(BUSY_MESSAGE);
  });

  it("有改动没落盘：不装，说明原因", () => {
    const step = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input({ unsavedChanges: true }), NOW);
    expect(step.install).toBe(false);
    expect(step.state.waiting).toBe(UNSAVED_MESSAGE);
  });

  it("条件恢复后重新走倒计时，而不是立刻装", () => {
    const blocked = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input({ pendingTasks: 1 }), NOW);
    const resumed = autoStep(blocked.state, input(), NOW + 60_000);
    expect(resumed.install).toBe(false);
    expect(resumed.state.waiting).toBe("");
    expect(resumed.state.deadline).toBe(NOW + 60_000 + AUTO_INSTALL_DELAY_MS);
  });

  it("条件恢复后倒计时走完才装", () => {
    const blocked = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input({ unsavedChanges: true }), NOW);
    const counting = autoStep(blocked.state, input(), NOW);
    const done = autoStep(counting.state, input(), NOW + AUTO_INSTALL_DELAY_MS);
    expect(done.install).toBe(true);
  });
});

describe("自动安装：倒计时", () => {
  it("空闲但倒计时没到点：不装，剩余秒数递减", () => {
    const started = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input(), NOW);
    expect(started.install).toBe(false);
    expect(started.state.deadline).toBe(NOW + AUTO_INSTALL_DELAY_MS);
    expect(autoInstallView(started.state, NOW).seconds).toBe(30);
    const later = autoStep(started.state, input(), NOW + 20_000);
    expect(later.install).toBe(false);
    expect(autoInstallView(later.state, NOW + 20_000).seconds).toBe(10);
  });

  it("差一毫秒不装，到点才装", () => {
    const started = autoStep({ ...INITIAL_AUTO_STATE, startup: "other" }, input(), NOW);
    expect(autoStep(started.state, input(), NOW + AUTO_INSTALL_DELAY_MS - 1).install).toBe(false);
    const done = autoStep(started.state, input(), NOW + AUTO_INSTALL_DELAY_MS);
    expect(done.install).toBe(true);
    expect(done.state.deadline).toBeNull();
    expect(done.state.waiting).toBe("");
  });
});

describe("自动安装：启动时就已就绪", () => {
  it("启动空闲就直接装，不倒计时", () => {
    const step = autoStep(INITIAL_AUTO_STATE, input(), NOW);
    expect(step.install).toBe(true);
    expect(step.state.startup).toBe("other");
  });

  it("启动有任务：不当场装，恢复后按倒计时走", () => {
    const blocked = autoStep(INITIAL_AUTO_STATE, input({ pendingTasks: 1 }), NOW);
    expect(blocked.install).toBe(false);
    expect(blocked.state.startup).toBe("other");
    const resumed = autoStep(blocked.state, input(), NOW + 1_000);
    expect(resumed.install).toBe(false);
    expect(resumed.state.deadline).toBe(NOW + 1_000 + AUTO_INSTALL_DELAY_MS);
  });

  it("启动时是别的阶段：之后才就绪的要倒计时", () => {
    const idle = autoStep(INITIAL_AUTO_STATE, input({ snapshot: emptySnapshot() }), NOW);
    expect(idle.state.startup).toBe("other");
    const readyStep = autoStep(idle.state, input(), NOW + 2_000);
    expect(readyStep.install).toBe(false);
    expect(readyStep.state.deadline).toBe(NOW + 2_000 + AUTO_INSTALL_DELAY_MS);
  });

  it("第一份真实快照之后不再改「启动就绪」的判断", () => {
    const other: AutoInstallState = { ...INITIAL_AUTO_STATE, startup: "other" };
    expect(autoStep(other, input(), NOW).install).toBe(false);
  });
});

/** 可编排的自动安装：时钟、安装结局与界面回调都记下来。 */
function harness(outcome: () => Promise<InstallOutcome> = async () => ({ ok: true })) {
  let now = NOW;
  const views: number[] = [];
  const installs: number[] = [];
  const machine = createAutoInstall({
    now: () => now,
    install: () => {
      installs.push(now);
      return outcome();
    },
    changed: (view) => views.push(view.seconds),
  });
  return {
    machine,
    installs,
    views,
    setNow(next: number) {
      now = next;
    },
  };
}

/** 等一轮微任务：安装是异步的，结局要落回状态。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("自动安装：接线", () => {
  it("到点交给安装器，只交一次", async () => {
    const h = harness();
    h.machine.pump(input({ snapshot: emptySnapshot() }));
    h.machine.pump(input());
    expect(h.installs).toHaveLength(0);
    h.setNow(NOW + AUTO_INSTALL_DELAY_MS);
    const view = h.machine.pump(input());
    expect(view.installing).toBe(true);
    expect(h.installs).toEqual([NOW + AUTO_INSTALL_DELAY_MS]);
    await settle();
    // 装上了：状态停在「已交给安装器」，不再重试。
    expect(h.machine.view().installing).toBe(true);
    h.machine.pump(input());
    expect(h.installs).toHaveLength(1);
  });

  it("装失败了：回到等待并说清原因，之后按倒计时重来", async () => {
    const h = harness(async () => ({ ok: false, reason: BUSY_MESSAGE }));
    h.machine.pump(input());
    expect(h.installs).toHaveLength(1);
    await settle();
    const failed = h.machine.view();
    expect(failed.installing).toBe(false);
    expect(failed.waiting).toBe(BUSY_MESSAGE);
    // 再推一步：条件恢复后重新倒计时，不立刻重试。
    const resumed = h.machine.pump(input());
    expect(resumed.counting).toBe(true);
    expect(h.installs).toHaveLength(1);
  });

  it("装失败但没给原因：不编一个原因出来", async () => {
    const h = harness(async () => ({ ok: false }));
    h.machine.pump(input());
    await settle();
    expect(h.machine.view().waiting).toBe("");
  });

  it("点了稍后：本轮再也不装，界面收到新样子", async () => {
    const h = harness();
    h.machine.pump(input({ snapshot: emptySnapshot() }));
    h.machine.defer();
    expect(h.views).toContain(0);
    expect(h.machine.view().deferred).toBe(true);
    h.setNow(NOW + AUTO_INSTALL_DELAY_MS * 4);
    h.machine.pump(input());
    expect(h.installs).toHaveLength(0);
  });
});

describe("自动安装的界面样子", () => {
  it("不在倒计时时剩余秒数为 0", () => {
    expect(autoInstallView(INITIAL_AUTO_STATE, NOW)).toEqual(IDLE_AUTO_VIEW);
  });

  it("倒计时跨过截止时刻也不显示负数", () => {
    const state: AutoInstallState = { ...INITIAL_AUTO_STATE, deadline: NOW };
    expect(autoInstallView(state, NOW + 5_000).seconds).toBe(0);
  });

  it("剩余秒数向上取整", () => {
    const state: AutoInstallState = { ...INITIAL_AUTO_STATE, deadline: NOW + 1_500 };
    expect(autoInstallView(state, NOW).seconds).toBe(2);
  });

  it("两份样子逐个字段比较", () => {
    expect(sameAutoInstallView(IDLE_AUTO_VIEW, { ...IDLE_AUTO_VIEW })).toBe(true);
    expect(sameAutoInstallView(IDLE_AUTO_VIEW, { ...IDLE_AUTO_VIEW, counting: true })).toBe(false);
    expect(sameAutoInstallView(IDLE_AUTO_VIEW, { ...IDLE_AUTO_VIEW, seconds: 3 })).toBe(false);
    expect(sameAutoInstallView(IDLE_AUTO_VIEW, { ...IDLE_AUTO_VIEW, waiting: BUSY_MESSAGE })).toBe(false);
    expect(sameAutoInstallView(IDLE_AUTO_VIEW, { ...IDLE_AUTO_VIEW, deferred: true })).toBe(false);
    expect(sameAutoInstallView(IDLE_AUTO_VIEW, { ...IDLE_AUTO_VIEW, installing: true })).toBe(false);
  });
});

describe("自动安装的那一句", () => {
  it("不是就绪阶段：沿用阶段文案（下载中带进度）", () => {
    expect(autoInstallText(IDLE_AUTO_VIEW, ready({ phase: "downloading", downloaded: 50, total: 100 }))).toContain("正在下载 1.6.2（50%）");
  });

  it("正在装：说正在保存并重启", () => {
    expect(autoInstallText({ ...IDLE_AUTO_VIEW, installing: true }, ready())).toContain("正在保存并重启安装");
  });

  it("倒计时中：给剩余秒数", () => {
    expect(autoInstallText({ ...IDLE_AUTO_VIEW, counting: true, seconds: 12 }, ready())).toContain("12 秒后自动保存并重启安装");
  });

  it("等条件：说清在等什么", () => {
    expect(autoInstallText({ ...IDLE_AUTO_VIEW, waiting: BUSY_MESSAGE }, ready())).toContain(BUSY_MESSAGE);
  });

  it("点过稍后：说清本次不自动装、去高级设置手动装", () => {
    const text = autoInstallText({ ...IDLE_AUTO_VIEW, deferred: true }, ready());
    expect(text).toContain("本次不再自动安装");
    expect(text).toContain("高级设置");
  });

  it("就绪但没在倒计时（比如没验签）：沿用阶段文案", () => {
    expect(autoInstallText(IDLE_AUTO_VIEW, ready({ verified: false }))).toContain("已下载并验签");
  });
});
