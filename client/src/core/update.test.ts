import { describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  STARTUP_DELAY_MS,
  canCheck,
  canInstall,
  emptySnapshot,
  nextCheckDelay,
  progressText,
  sameUpdateSnapshot,
  updateText,
  type UpdateSnapshot,
} from "./update";

/** 造一个快照：只写关心的字段，其余用空快照兜。 */
function snap(patch: Partial<UpdateSnapshot>): UpdateSnapshot {
  return { ...emptySnapshot(), ...patch };
}

describe("快照内容比较（#180）", () => {
  const base = (): UpdateSnapshot => ({
    phase: "downloading",
    current: "1.6.1",
    version: "1.6.2",
    notes: "更新说明",
    page_url: "https://example.invalid/1.6.2",
    downloaded: 10,
    total: 100,
    verified: true,
    installable: false,
    error: "",
    checked_at: "2026-01-01T00:00:00Z",
  });

  it("逐字段相同的两份快照算一样", () => {
    expect(sameUpdateSnapshot(base(), { ...base() })).toBe(true);
  });

  it("任何一个字段变了都算不一样", () => {
    for (const key of Object.keys(base()) as (keyof UpdateSnapshot)[]) {
      const value = base()[key];
      const flipped = typeof value === "string" ? `${value}x` : typeof value === "number" ? value + 1 : !value;
      expect(sameUpdateSnapshot(base(), { ...base(), [key]: flipped })).toBe(false);
    }
  });
});

describe("更新排程", () => {
  it("启动约 3 秒后检查第一次", () => {
    expect(nextCheckDelay(emptySnapshot(), 0)).toBe(STARTUP_DELAY_MS);
    expect(STARTUP_DELAY_MS).toBe(3000);
  });

  it("每次检查结束后约 6 小时再检查", () => {
    const checkedAt = "2026-11-17T12:00:00Z";
    const at = Date.parse(checkedAt);
    const s = snap({ phase: "up_to_date", checked_at: checkedAt });
    expect(nextCheckDelay(s, at)).toBe(CHECK_INTERVAL_MS);
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    // 已经过了 1 小时：再等 5 小时，而不是从启动重新算 6 小时。
    expect(nextCheckDelay(s, at + 60 * 60 * 1000)).toBe(5 * 60 * 60 * 1000);
  });

  it("过点了就立刻排（不排负数）", () => {
    const s = snap({ phase: "up_to_date", checked_at: "2026-11-17T12:00:00Z" });
    const at = Date.parse("2026-11-17T12:00:00Z") + CHECK_INTERVAL_MS + 60_000;
    expect(nextCheckDelay(s, at)).toBe(0);
  });

  it("正在检查时不重复排，装的时候也不再排", () => {
    expect(nextCheckDelay(snap({ phase: "checking" }), 0)).toBeNull();
    expect(nextCheckDelay(snap({ phase: "installing" }), 0)).toBeNull();
  });

  it("更新不可用时根本不排", () => {
    expect(nextCheckDelay(snap({ phase: "disabled" }), 0)).toBeNull();
  });
});

describe("更新入口的可用性", () => {
  it("检查：正在检查或正在装时不能点，不可用时也不能点", () => {
    expect(canCheck(emptySnapshot())).toBe(true);
    expect(canCheck(snap({ phase: "checking" }))).toBe(false);
    expect(canCheck(snap({ phase: "installing" }))).toBe(false);
    expect(canCheck(snap({ phase: "disabled" }))).toBe(false);
  });

  it("安装：只有已验签且服务说可装才能点", () => {
    expect(canInstall(snap({ phase: "ready", verified: true, installable: true }))).toBe(true);
    // 下载完成但没验签：不能装。
    expect(canInstall(snap({ phase: "ready", verified: false, installable: false }))).toBe(false);
    // 还在下载：不能装。
    expect(canInstall(snap({ phase: "downloading", verified: false, installable: false }))).toBe(false);
    // 验签失败：不能装。
    expect(canInstall(snap({ phase: "error", verified: false, installable: false }))).toBe(false);
  });
});

describe("更新文案", () => {
  it("每个阶段都有一句话，且不把失败说成成功", () => {
    expect(updateText(snap({ phase: "disabled" }))).toContain("尚不可用");
    expect(updateText(snap({ phase: "checking" }))).toContain("检查");
    expect(updateText(snap({ phase: "up_to_date" }))).toContain("最新");
    expect(updateText(snap({ phase: "ready", version: "1.6.0", verified: true }))).toContain("1.6.0");
    expect(updateText(snap({ phase: "error", error: "网络不可达" }))).toBe("网络不可达");
  });

  it("下载进度按总字节算百分比，总字节未知时不给百分比", () => {
    expect(progressText(snap({ downloaded: 50, total: 200 }))).toBe("（25%）");
    expect(progressText(snap({ downloaded: 50, total: 0 }))).toBe("");
    // 下载字节超过描述里的总字节时不出现 100% 以上的进度。
    expect(progressText(snap({ downloaded: 500, total: 200 }))).toBe("（100%）");
  });
});
