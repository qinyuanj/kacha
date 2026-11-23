import { describe, expect, it, vi } from "vitest";
import { createUpdateScheduler } from "./updateScheduler";
import { CHECK_INTERVAL_MS, STARTUP_DELAY_MS, emptySnapshot, type UpdateSnapshot } from "./update";

/** 假时钟：排程只按注入的 schedule/now 走，测试不等真实时间。 */
function clock(initial = 0) {
  let now = initial;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    schedule(ms: number, run: () => void) {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** 走到下一个到期计时器并执行它；没有就到 false。 */
    tick(): boolean {
      const live = timers.filter((t) => !t.cancelled);
      if (live.length === 0) return false;
      live.sort((a, b) => a.at - b.at);
      const next = live[0];
      now = next.at;
      next.cancelled = true;
      next.run();
      return true;
    },
    /** 还没被取消的计时器数。 */
    live: () => timers.filter((t) => !t.cancelled).length,
    /** 最近排的那个计时器还差多久。 */
    due: () => {
      const live = timers.filter((t) => !t.cancelled);
      return live.length === 0 ? null : Math.max(...live.map((t) => t.at - now));
    },
  };
}

function setup(snapshot: UpdateSnapshot, startedAt = 0) {
  const c = clock(startedAt);
  let current = snapshot;
  const check = vi.fn(() => {
    // 真实服务会更新 checked_at：这里模拟「检查结束，记下时间」。
    current = { ...current, phase: "up_to_date", checked_at: new Date(c.now()).toISOString() };
  });
  const scheduler = createUpdateScheduler({
    snapshot: () => current,
    check,
    schedule: c.schedule,
    now: c.now,
  });
  return { c, scheduler, check, set: (s: UpdateSnapshot) => (current = s) };
}

describe("更新排程", () => {
  it("启动后先等约 3 秒再检查，不是立刻", () => {
    const { c, scheduler, check } = setup(emptySnapshot());
    scheduler.start();
    expect(check).not.toHaveBeenCalled();
    expect(c.due()).toBe(STARTUP_DELAY_MS);
    c.tick();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("检查完成不自行排下一次，由调用方重排且间隔 15 分钟", () => {
    const { c, scheduler, check } = setup(emptySnapshot());
    scheduler.start();
    c.tick();
    expect(check).toHaveBeenCalledTimes(1);
    // 检查是异步的：模块不自行重排，界面记下 checked_at 后由调用方 reschedule。
    expect(c.live()).toBe(0);
    scheduler.reschedule();
    expect(c.due()).toBe(CHECK_INTERVAL_MS);
    c.tick();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("已排的检查到点时若已在检查，就不再叠加一次", () => {
    const { c, scheduler, check, set } = setup(emptySnapshot());
    scheduler.start();
    // 检查阶段由快照持有；期间启动那次计时器还在。
    set({ ...emptySnapshot(), phase: "checking" });
    c.tick();
    expect(check).not.toHaveBeenCalled();
  });

  it("更新不可用时既不排定时器，也不触发检查", () => {
    const { c, scheduler, check } = setup({ ...emptySnapshot(), phase: "disabled" });
    scheduler.start();
    expect(c.live()).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });

  it("卸载后计时器不再触发", () => {
    const { c, scheduler, check } = setup(emptySnapshot());
    const stop = scheduler.start();
    stop();
    expect(c.live()).toBe(0);
    c.tick();
    expect(check).not.toHaveBeenCalled();
  });
});
