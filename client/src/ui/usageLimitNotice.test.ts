// 用量上限提醒的分档（#137）：没到线不提醒，到了给档位与数字。
import { describe, expect, it } from "vitest";
import type { Usage } from "../shell/types";
import { usageNoticeOf } from "./usageLimitNotice";

function usage(patch: Partial<Usage> = {}): Usage {
  return {
    total_bytes: 100,
    boards_bytes: 50,
    meta_bytes: 50,
    last_access: 0,
    by_date: [],
    unreferenced: null,
    unreadable_board: null,
    limit_bytes: null,
    limit_level: null,
    ...patch,
  };
}

describe("用量上限提醒", () => {
  it("上限留空：不提醒", () => {
    expect(usageNoticeOf(usage())).toBeNull();
  });

  it("有上限但没到线：存储端口没给档位就不提醒", () => {
    expect(usageNoticeOf(usage({ limit_bytes: 1000 }))).toBeNull();
  });

  it("达到阈值：给出档位与数字", () => {
    expect(usageNoticeOf(usage({ limit_bytes: 100, limit_level: "warn" }))).toEqual({ level: "warn", total: 100, limit: 100 });
    expect(usageNoticeOf(usage({ limit_bytes: 50, limit_level: "alert" }))).toEqual({ level: "alert", total: 100, limit: 50 });
  });
});
