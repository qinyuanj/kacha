// 用量区块的可见判定（#137）：未引用目录的摘要、清理按钮的禁用条件、清理完成说明。
import { describe, expect, it } from "vitest";
import type { Usage } from "../shell/types";
import { canClean, cleanupNote, unreferencedSummary, usageByDate, usageBreakdown } from "./usageView";

const dir = (name: string, bytes: number) => ({ dir: name, bytes, last_write: 0 });

function usage(patch: Partial<Usage> = {}): Usage {
  return { total_bytes: 100, boards_bytes: 50, meta_bytes: 50, last_access: 0, by_date: [], unreferenced: null, unreadable_board: null, limit_bytes: null, limit_level: null, ...patch };
}

describe("用量区块", () => {
  it("没有未引用目录：摘要说明没有", () => {
    expect(unreferencedSummary([])).toBe("没有未引用任务目录");
  });

  it("有未引用目录：给个数与体量", () => {
    expect(unreferencedSummary([dir("a", 1024), dir("b", 1024)])).toBe("2 个未引用任务目录，共 2.0 KiB");
  });

  it("清理按钮：没有目录时禁用", () => {
    expect(canClean(usage(), false)).toBe(false);
  });

  it("清理按钮：有目录时可点", () => {
    expect(canClean(usage({ unreferenced: [dir("a", 1)] }), false)).toBe(true);
  });

  it("清理按钮：有画板读不懂时禁用（为避免误删）", () => {
    expect(canClean(usage({ unreferenced: [dir("a", 1)], unreadable_board: "坏的画板" }), false)).toBe(false);
  });

  it("清理按钮：正在清理时禁用", () => {
    expect(canClean(usage({ unreferenced: [dir("a", 1)] }), true)).toBe(false);
  });

  it("清理完成说明：没有不符合条件的就不提", () => {
    expect(cleanupNote({ moved: [dir("a", 1)], skipped: [] })).toBe("已把 1 个任务目录移入回收区");
    expect(cleanupNote({ moved: [dir("a", 1)], skipped: ["b"] })).toBe("已把 1 个任务目录移入回收区；1 个已不符合条件，未动");
  });

  it("分项说明：画板、设置与缓存、最后访问", () => {
    const text = usageBreakdown(usage({ last_access: 1 }));
    expect(text).toContain("画板 50 B");
    expect(text).toContain("设置与缓存 50 B");
    expect(text).toContain("最后访问");
  });

  it("按日期的用量：没有目录时说明没有", () => {
    expect(usageByDate(usage())).toBe("还没有任务目录");
    expect(usageByDate(usage({ by_date: [{ date: "2026-11-01", bytes: 100 }] }))).toContain("2026-11-01");
  });
});
