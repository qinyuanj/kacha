// 工作台视图模型的判定（#137）：派生值一次算好，界面只按它渲染。
import { describe, expect, it, vi } from "vitest";
import { emptyHistory } from "../core/history";
import type { Session } from "./useBoardSessions";
import {
  appView,
  canvasBoard,
  createBoardOrExplain,
  dismissBoardNotice,
  dismissSizeAction,
  focusFor,
  openFromList,
  sizeQueryOf,
  tidyAction,
  tidyKeyAfter,
  tidyingFor,
  updateNoticeOf,
} from "./appView";

const okSession = (patch: Partial<Extract<Session, { status: "ok" }>> = {}): Session => ({
  key: "k1",
  path: "/~/画板/a.ugcboard.json",
  status: "ok",
  board: { format_version: 2, title: "标题", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} },
  history: emptyHistory(),
  notice: null,
  saveError: null,
  version: "v1",
  conflicted: false,
  missing: false,
  ...patch,
});

describe("工作台视图模型", () => {
  it("派生值一次算好", () => {
    const view = appView({ sessions: [okSession()], activeKey: "k1", userRoot: "/~", activeSize: null, sizeNotices: {} });
    expect(view.openState).toBe("ok");
    expect(view.activeArchived).toBe(false);
    expect(view.undoLabel).toBeNull();
    expect(view.exportDisabled).toBeNull();
    expect(view.titleOf("k1")).toBe("标题");
  });

});

describe("体量查询与提示", () => {
  it("体量查询：ok 状态才有路径与版本", () => {
    expect(sizeQueryOf(okSession())).toEqual({ path: "/~/画板/a.ugcboard.json", version: "v1" });
    expect(sizeQueryOf(undefined)).toBeNull();
  });

  it("没有体量提示：两个动作都不做", () => {
    const view = appView({ sessions: [okSession()], activeKey: "k1", userRoot: "/~", activeSize: null, sizeNotices: {} });
    const setSizeNotices = vi.fn();
    tidyAction(view, {}, setSizeNotices, vi.fn());
    dismissSizeAction(view, {}, setSizeNotices);
    expect(setSizeNotices).not.toHaveBeenCalled();
  });
});

describe("用量与更新提示", () => {
  it("更新提示：没准备好或没有版本都不提示", () => {
    expect(updateNoticeOf(false, "1.0", undefined, () => true)).toBeNull();
    expect(updateNoticeOf(true, null, undefined, () => true)).toBeNull();
  });

  it("更新提示：已经看过就不提示", () => {
    expect(updateNoticeOf(true, "1.0", "1.0", () => false)).toBeNull();
    expect(updateNoticeOf(true, "1.0", "0.9", () => true)).toBe("1.0");
  });
});

describe("其它判定", () => {
  it("画布的画板：没有画板时给占位", () => {
    const empty = { format_version: 2, title: "", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} } as never;
    expect(canvasBoard(okSession(), empty).title).toBe("标题");
    expect(canvasBoard(undefined, empty).title).toBe("");
  });

  it("聚焦请求：不是当前画板的不给", () => {
    expect(focusFor({ boardKey: "k1", nodeId: "n", nonce: 1 }, okSession())).toEqual({ boardKey: "k1", nodeId: "n", nonce: 1 });
    expect(focusFor({ boardKey: "k9", nodeId: "n", nonce: 1 }, okSession())).toBeNull();
    expect(focusFor(null, okSession())).toBeNull();
  });

  it("整理模式：归档画板不能整理", () => {
    expect(tidyingFor("k1", okSession(), false)).toBe(true);
    expect(tidyingFor("k1", okSession(), true)).toBe(false);
    expect(tidyingFor("k9", okSession(), false)).toBe(false);
  });

  it("整理模式开关：关掉时为 null", () => {
    expect(tidyKeyAfter(true, okSession())).toBe("k1");
    expect(tidyKeyAfter(false, okSession())).toBeNull();
  });

  it("新建画板：画板位满时提示统一文案", async () => {
    const toast = vi.fn();
    await createBoardOrExplain(async () => "画板位满了", toast);
    expect(toast).toHaveBeenCalledWith("画板位满了");
  });

  it("新建画板：成功时不提示", async () => {
    const toast = vi.fn();
    await createBoardOrExplain(async () => null, toast);
    expect(toast).not.toHaveBeenCalled();
  });

  it("从列表打开：打不开时提示", async () => {
    const toast = vi.fn();
    openFromList(async () => false, toast, "/~/a");
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
  });

  it("画板自己的提示：关掉它", () => {
    const dismiss = vi.fn();
    dismissBoardNotice(okSession(), dismiss);
    expect(dismiss).toHaveBeenCalledWith("k1");
  });

  it("没有画板：不用关提示", () => {
    const dismiss = vi.fn();
    dismissBoardNotice(undefined, dismiss);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
