// 移出为新画板的最后两步（#137）：写新画板与从原画板删节点。
import { describe, expect, it, vi } from "vitest";
import type { Board } from "../core/board";
import { finishMoveOut, writeMovedOut } from "./boardSessionsMoveOut";

const board = (title = "新"): Board => ({ format_version: 2, title, viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });

describe("写新画板", () => {
  it("写成功：没有说明", async () => {
    const write = vi.fn(async () => undefined);
    const message = await writeMovedOut({ board: { write } } as never, "/~/a.ugcboard.json", board());
    expect(message).toBeNull();
    expect(write).toHaveBeenCalled();
  });

  it("写不进去：给错误说明", async () => {
    const write = vi.fn(async () => {
      throw new Error("offline");
    });
    const message = await writeMovedOut({ board: { write } } as never, "/~/a.ugcboard.json", board());
    expect(message).toContain("offline");
  });
});

describe("从原画板删节点", () => {
  it("没有新改动：删掉并说移出成功", () => {
    const latest = board("旧");
    const apply = vi.fn(() => ({ step: {} } as never));
    const message = finishMoveOut(() => latest, apply, "k1", "s1", board("新"), latest);
    expect(apply).toHaveBeenCalledWith("k1", { kind: "moveOutStage", stageId: "s1" });
    expect(message).toContain("新");
  });

  it("期间有新改动：新画板留着，原画板不动", () => {
    const apply = vi.fn();
    const message = finishMoveOut(() => board("变了"), apply, "k1", "s1", board("新"), board("旧"));
    expect(apply).not.toHaveBeenCalled();
    expect(message).toContain("移出期间本画板有了新的改动");
  });

  it("写好之后才被拒：新画板留着", () => {
    const latest = board("旧");
    const apply = vi.fn(() => ({ step: null, hint: "有任务在跑" } as never));
    const message = finishMoveOut(() => latest, apply, "k1", "s1", board("新"), latest);
    expect(message).toContain("新");
  });
});
