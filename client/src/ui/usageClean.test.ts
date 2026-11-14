// 用量区块的清理接线（#137）：清掉未被引用的结果目录。
import { describe, expect, it } from "vitest";
import type { Usage } from "../shell/types";
import { cleanUnreferenced, type CleanPort } from "./usageClean";

const usage = (patch: Partial<Usage> = {}): Usage => ({
  total_bytes: 0,
  boards_bytes: 0,
  meta_bytes: 0,
  last_access: 0,
  by_date: [],
  unreferenced: null,
  unreadable_board: null,
  limit_bytes: null,
  limit_level: null,
  ...patch,
});

const port = (patch: Partial<CleanPort["usage"]> = {}): CleanPort => ({
  usage: { cleanupUnreferenced: async () => ({ moved: [], skipped: [] }), ...patch },
});

describe("清理接线", () => {
  it("没有未引用目录：什么都不做", async () => {
    const result = await cleanUnreferenced(port(), usage());
    expect(result.kind).toBe("done");
  });

  it("清理成功：给一句说明", async () => {
    const result = await cleanUnreferenced(
      port({ cleanupUnreferenced: async () => ({ moved: [{ dir: "x", bytes: 1, last_write: 0 }], skipped: [] }) }),
      usage({ unreferenced: [{ dir: "x", bytes: 1, last_write: 0 }] }),
    );
    expect(result.kind).toBe("done");
    if (result.kind === "done") expect(result.note).toContain("已把 1 个任务目录移入回收区");
  });

  it("清理失败：给错误说明", async () => {
    const result = await cleanUnreferenced(
      port({
        cleanupUnreferenced: async () => {
          throw new Error("offline");
        },
      }),
      usage({ unreferenced: [{ dir: "x", bytes: 1, last_write: 0 }] }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("offline");
  });
});
