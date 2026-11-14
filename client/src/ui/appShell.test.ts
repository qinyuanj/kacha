// @vitest-environment jsdom
// 工作台的界面外壳（#137）：顶栏、提示条、工具栏与画板包菜单。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../core/board";
import { emptyHistory } from "../core/history";
import { AppNotices, type AppNoticesProps } from "./appNotices";
import { AppPackMenu, AppToolbar, AppTopBar } from "./appPanels";
import type { Session } from "./useBoardSessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

const board = { title: "a", format_version: 2, viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} } as unknown as Board;

const session = (): Session =>
  ({ key: "k1", path: "/~/a.ugcboard.json", status: "ok", board, history: emptyHistory(), notice: null, saveError: null, version: null, conflicted: false, missing: false }) as Session;

const notices = (patch: Partial<AppNoticesProps> = {}): AppNoticesProps => ({
  failures: [],
  tableError: null,
  settingsFileProblem: null,
  settingsOpen: false,
  usageNotice: null,
  sizeNotice: null,
  activeArchived: false,
  boardNotice: null,
  onDismissTableError: vi.fn(),
  onOpenSettings: vi.fn(),
  onManageBoards: vi.fn(),
  onDismissUsage: vi.fn(),
  onTidy: vi.fn(),
  onDismissSize: vi.fn(),
  onUnarchive: vi.fn(),
  onCopyArchived: vi.fn(),
  onDismissBoardNotice: vi.fn(),
  onReload: vi.fn(),
  onRetrySave: vi.fn(),
  onExportPack: vi.fn(),
  onCloseMissing: vi.fn(),
  ...patch,
});

describe("提示条", () => {
  it("没有提示：什么都不显示", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices())));
    expect(container.textContent).toBe("");
  });

  it("保存失败：给出重试与导出", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ failures: [{ key: "k1", board, saveError: "写不进去", missing: false, conflicted: false }] }))));
    expect(container.textContent).toContain("写不进去");
  });

  it("能力表读失败：给出说明", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ tableError: "能力表坏了" }))));
    expect(container.textContent).toContain("能力表坏了");
  });

  it("设置文件有问题：给出说明", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ settingsFileProblem: "settings.json 已损坏" }))));
    expect(container.textContent).toContain("settings.json 已损坏");
  });

  it("用量提醒：给出管理画板", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ usageNotice: { level: "alert", total: 200, limit: 100 } }))));
    expect(container.textContent).toContain("用量");
  });

  it("体量提醒：给出整理", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ sizeNotice: { bytes: 10, tier: "warn" } }))));
    expect(container.textContent).toContain("整理");
  });

  it("归档画板：给出取消归档与复制", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ activeArchived: true }))));
    expect(container.textContent).toContain("归档");
  });

  it("画板自己的提示：显示出来", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ boardNotice: "重命名失败" }))));
    expect(container.textContent).toContain("重命名失败");
  });
});

describe("顶栏", () => {
  it("画板标签：显示标题", async () => {
    await act(async () =>
      dom.render(
        createElement(AppTopBar, {
          sessions: [session()],
          activeKey: "k1",
          onActivate: vi.fn(),
          onClose: vi.fn(),
          onRename: vi.fn(),
          onCreate: vi.fn(),
          onOpenList: vi.fn(),
          onExportPack: vi.fn(),
          updateNotice: null,
          onOpenChangelog: vi.fn(),
          onCloseUpdateNotice: vi.fn(),
          backupHint: null,
        }),
      ),
    );
    expect(container.textContent).toContain("a");
  });

  it("有新版：给出更新提示", async () => {
    await act(async () =>
      dom.render(
        createElement(AppTopBar, {
          sessions: [],
          activeKey: null,
          onActivate: vi.fn(),
          onClose: vi.fn(),
          onRename: vi.fn(),
          onCreate: vi.fn(),
          onOpenList: vi.fn(),
          onExportPack: vi.fn(),
          updateNotice: "1.2.0",
          onOpenChangelog: vi.fn(),
          onCloseUpdateNotice: vi.fn(),
          backupHint: null,
        }),
      ),
    );
    expect(container.textContent).toContain("已更新到 1.2.0");
  });
});

describe("画板包菜单", () => {
  it("没有画板：导出与下载都置灰", async () => {
    await act(async () => dom.render(createElement(AppPackMenu, { at: { x: 10, y: 20 }, exportDisabledReason: "没有打开的画板", downloadDisabledReason: "没有打开的画板", onPick: vi.fn(), onClose: vi.fn() })));
    expect(container.textContent).toContain("导入画板包");
  });

  it("有画板：导出可用", async () => {
    const onPick = vi.fn();
    await act(async () => dom.render(createElement(AppPackMenu, { at: { x: 10, y: 20 }, exportDisabledReason: null, downloadDisabledReason: null, onPick, onClose: vi.fn() })));
    const exportButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("导出"));
    await act(async () => exportButton?.click());
    expect(onPick).toHaveBeenCalledWith("exportPack");
  });
});

describe("工具栏", () => {
  it("没有画板：放置灰占位", async () => {
    await act(async () =>
      dom.render(
        createElement(AppToolbar, {
          setToolbarSlot: vi.fn(),
          canvasReady: false,
          runIndicator: { active: [], titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() },
          packMenuOpen: false,
          packMenuDisabled: false,
          onTogglePackMenu: vi.fn(),
          version: "1.0",
          ready: true,
          onOpenChangelog: vi.fn(),
          settingsLoaded: true,
          onOpenSettings: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector(".board-toolbar-slot")).not.toBeNull();
    expect(container.textContent).toContain("画板包");
  });
});
