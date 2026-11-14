// 画板列表的各个动作（#137）：确认动作与取消归档 / 复制。
import { describe, expect, it } from "vitest";
import { runArchivedAction, runConfirm, type PendingAction } from "./boardListActions";

const entry = { name: "a", path: "/~/a.ugcboard.json", archived: false, bytes: 10 };

describe("确认动作", () => {
  it("没有待确认的：什么都不做", async () => {
    const result = await runConfirm(null, async () => undefined);
    expect(result.ok).toBe(false);
  });

  it("成功：关掉确认框", async () => {
    const pending: PendingAction = { entry, busy: false, error: null };
    const result = await runConfirm(pending, async () => undefined);
    expect(result.ok).toBe(true);
  });

  it("失败：把错误留在框里", async () => {
    const pending: PendingAction = { entry, busy: false, error: null };
    const result = await runConfirm(pending, async () => {
      throw new Error("offline");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("offline");
  });
});

describe("取消归档与复制", () => {
  it("成功：没有说明", async () => {
    expect(await runArchivedAction(async () => null, entry)).toBeNull();
  });

  it("被拒：给统一文案", async () => {
    expect(await runArchivedAction(async () => "画板位满了", entry)).toBe("画板位满了");
  });

  it("失败：给错误说明", async () => {
    const message = await runArchivedAction(async () => {
      throw new Error("offline");
    }, entry);
    expect(message).toContain("offline");
  });
});
