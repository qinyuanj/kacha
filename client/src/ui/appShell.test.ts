// @vitest-environment jsdom
// 工作台的界面外壳（#137）：顶栏、提示条、工具栏与画板包菜单。
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { AppNotices, type AppNoticesProps } from "./appNotices";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import type { ThemeControl } from "./useTheme";
import type { UpdateControl } from "./useUpdate";
import { IDLE_AUTO_VIEW, type AutoInstallView } from "../core/updateAutoInstall";
import { updateStatusView } from "./updateStatusView";
import { AppPackMenu, AppToolbar, AppTopBar } from "./appPanels";
import { AppShell } from "./appShell";
import type { AppView } from "./appView";
import { ShellProvider } from "./shell";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";

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

// 主题切换入口的替身（#221）：工具栏只负责把档位与切换动作摆出来。
const themeControl = (patch: Partial<ThemeControl> = {}): ThemeControl => ({ choice: "dark", effective: "dark", choose: vi.fn(), ...patch });
// 更新入口的替身（#181）：首页版本号旁的那一份，快照与动作都可直接调用。
const updateControl = (patch: Partial<UpdateSnapshot> = {}): UpdateControl => ({
  snapshot: { ...emptySnapshot(), ...patch },
  state: { preparing: false, prepareError: "", installError: "" },
  check: vi.fn(),
  install: vi.fn(async () => ({ ok: true })),
});

const notices = (patch: Partial<AppNoticesProps> = {}): AppNoticesProps => ({
  updateStatus: updateStatusView({ snapshot: emptySnapshot(), auto: IDLE_AUTO_VIEW }),
  onDeferUpdate: vi.fn(),
  failures: [],
  tableError: null,
  settingsFileProblem: null,
  settingsOpen: false,
  usageNotice: null,
  activeArchived: false,
  boardNotice: null,
  onDismissTableError: vi.fn(),
  onOpenSettings: vi.fn(),
  onManageBoards: vi.fn(),
  onDismissUsage: vi.fn(),
  onUnarchive: vi.fn(),
  onCopyArchived: vi.fn(),
  onDismissBoardNotice: vi.fn(),
  onReload: vi.fn(),
  onRetrySave: vi.fn(),
  onExportPack: vi.fn(),
  onCloseMissing: vi.fn(),
  ...patch,
});

/** 已经下载并验签的快照：主界面提示条「已就绪」用。 */
const ready = (): UpdateSnapshot => ({ ...emptySnapshot(), phase: "ready", version: "1.6.2", verified: true, installable: true, downloaded: 100, total: 100 });

/** 倒计时中的样子：30 秒后自动装。 */
const COUNTING: AutoInstallView = { counting: true, seconds: 30, waiting: "", deferred: false, installing: false };

/** 更新提示条：按阶段与自动安装的样子渲染。 */
const updateCase = (patch: Partial<UpdateSnapshot>, auto: AutoInstallView = IDLE_AUTO_VIEW): AppNoticesProps =>
  notices({ updateStatus: updateStatusView({ snapshot: { ...emptySnapshot(), ...patch }, auto }) });

describe("提示条", () => {
  it("没有提示：什么都不显示", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices())));
    expect(container.textContent).toBe("");
  });

  it("能力表读失败：给出说明", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ tableError: "能力表坏了" }))));
    expect(container.textContent).toContain("能力表坏了");
  });

  it("设置文件有问题：给出说明", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ settingsFileProblem: "settings.json 已损坏" }))));
    expect(container.textContent).toContain("settings.json 已损坏");
  });

  it("画板自己的提示：显示出来", async () => {
    await act(async () => dom.render(createElement(AppNotices, notices({ boardNotice: "重命名失败" }))));
    expect(container.textContent).toContain("重命名失败");
  });

  it("发现新版本：主界面就能看见，不用进高级设置（#180）", async () => {
    await act(async () => dom.render(createElement(AppNotices, updateCase({ phase: "available", version: "1.6.2" }))));
    expect(container.textContent).toContain("发现新版本 1.6.2");
    // 没有可推迟的事，就没有「稍后」。
    expect(container.querySelector("button")).toBeNull();
  });

  it("下载中：提示条带着百分比", async () => {
    await act(async () => dom.render(createElement(AppNotices, updateCase({ phase: "downloading", version: "1.6.2", downloaded: 50, total: 100 }))));
    expect(container.textContent).toContain("正在下载 1.6.2（50%）");
  });

  it("已就绪：倒计时与「稍后」都在主界面", async () => {
    const defer = vi.fn();
    await act(async () => dom.render(createElement(AppNotices, notices({ updateStatus: updateStatusView({ snapshot: ready(), auto: COUNTING }), onDeferUpdate: defer }))));
    expect(container.textContent).toContain("30 秒后自动保存并重启安装");
    const later = [...container.querySelectorAll("button")].find((b) => b.textContent === "稍后");
    if (!later) throw new Error("没有找到「稍后」按钮");
    await act(async () => later.click());
    expect(defer).toHaveBeenCalledTimes(1);
  });

  it("点了稍后：说清本次不再自动装", async () => {
    await act(async () =>
      dom.render(createElement(AppNotices, notices({ updateStatus: updateStatusView({ snapshot: ready(), auto: { ...IDLE_AUTO_VIEW, deferred: true } }) }))),
    );
    expect(container.textContent).toContain("本次不再自动安装");
  });
});

describe("顶栏", () => {
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
        }),
      ),
    );
    expect(container.textContent).toContain("已更新到 1.2.0");
  });
});

describe("画板包菜单", () => {
  it("没有画板：导出与下载都置灰", async () => {
    const onPick = vi.fn();
    await act(async () => dom.render(createElement(AppPackMenu, { at: { x: 10, y: 20 }, importDisabledReason: null, exportDisabledReason: "没有打开的画板", downloadDisabledReason: "没有打开的画板", onPick, onClose: vi.fn() })));
    const items = () => [...container.querySelectorAll('[role="menuitem"]')];
    for (const action of ["导出画板包", "下载整板结果"]) {
      const button = items().find((b) => b.textContent?.includes(action));
      expect(button?.getAttribute("aria-disabled")).toBe("true");
      await act(async () => (button as HTMLButtonElement | undefined)?.click());
    }
    expect(onPick).not.toHaveBeenCalled();
  });

  it("端口没有导入能力：导入标「尚不可用」并置灰", async () => {
    await act(async () => dom.render(createElement(AppPackMenu, { at: { x: 10, y: 20 }, importDisabledReason: "画板包导入" + UNAVAILABLE_TEXT, exportDisabledReason: null, downloadDisabledReason: null, onPick: vi.fn(), onClose: vi.fn() })));
    const importButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("导入画板包"));
    expect(importButton?.textContent).toContain(UNAVAILABLE_TEXT);
    // 置灰态用 aria-disabled 表示（与画布菜单同一口径）。
    expect(importButton?.getAttribute("aria-disabled")).toBe("true");
  });

  it("有画板：导出可用", async () => {
    const onPick = vi.fn();
    await act(async () => dom.render(createElement(AppPackMenu, { at: { x: 10, y: 20 }, importDisabledReason: null, exportDisabledReason: null, downloadDisabledReason: null, onPick, onClose: vi.fn() })));
    const exportButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("导出"));
    await act(async () => exportButton?.click());
    expect(onPick).toHaveBeenCalledWith("exportPack");
  });
});

describe("工具栏", () => {
  it("没有画板：放置灰占位", async () => {
    await act(async () =>
      dom.render(
        createElement(ShellProvider, { port: createFakePort(), children: createElement(AppToolbar, {
          setToolbarSlot: vi.fn(),
          canvasReady: false,
          runIndicator: { active: [], activity: { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] }, titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() },
          packMenuOpen: false,
          packMenuDisabled: false,
          onTogglePackMenu: vi.fn(),
          version: "1.0",
          ready: true,
          onOpenChangelog: vi.fn(),
          settingsLoaded: true,
          onOpenSettings: vi.fn(),
          onOpenFeedback: vi.fn(), update: updateControl(), theme: themeControl(),
        }) }),
      ),
    );
    expect(container.querySelector(".board-toolbar-slot")).not.toBeNull();
    expect(container.textContent).toContain("画板包");
  });

  // #181：更新入口在首页版本号旁边，不再藏在高级设置里。
  it("版本号旁边有检查更新入口", async () => {
    await act(async () =>
      dom.render(
        createElement(ShellProvider, { port: createFakePort(), children: createElement(AppToolbar, {
          setToolbarSlot: vi.fn(),
          canvasReady: false,
          runIndicator: { active: [], activity: { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] }, titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() },
          packMenuOpen: false,
          packMenuDisabled: false,
          onTogglePackMenu: vi.fn(),
          version: "1.6.6",
          ready: true,
          onOpenChangelog: vi.fn(),
          settingsLoaded: true,
          onOpenSettings: vi.fn(),
          onOpenFeedback: vi.fn(), update: updateControl(), theme: themeControl(),
        }) }),
      ),
    );
    const version = container.querySelector(".topbar-version");
    const entry = container.querySelector(".topbar-update");
    expect(version).not.toBeNull();
    expect(entry).not.toBeNull();
    // 入口紧挨着版本号：两者在同一个工具栏右侧容器里，版本号在前。
    expect(container.textContent?.indexOf("1.6.6")).toBeLessThan(container.textContent?.indexOf("检查更新") ?? Infinity);
    expect(entry?.textContent).toContain("检查更新");
  });

  // #264：齿轮按钮本身是入口契约；尺寸与焦点环沿用共享 .icon-button，弹窗流程由 App 层守。
  it("高级设置入口只有齿轮图标，仍有无障碍名称、提示与焦点", async () => {
    await act(async () =>
      dom.render(
        createElement(ShellProvider, { port: createFakePort(), children: createElement(AppToolbar, {
          setToolbarSlot: vi.fn(),
          canvasReady: false,
          runIndicator: { active: [], activity: { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] }, titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() },
          packMenuOpen: false,
          packMenuDisabled: false,
          onTogglePackMenu: vi.fn(),
          version: "1.6.6",
          ready: true,
          onOpenChangelog: vi.fn(),
          settingsLoaded: true,
          onOpenSettings: vi.fn(),
          onOpenFeedback: vi.fn(), update: updateControl(), theme: themeControl(),
        }) }),
      ),
    );
    const button = container.querySelector<HTMLButtonElement>("button[aria-label='高级设置']");
    expect(button).not.toBeNull();
    expect(button?.textContent?.trim()).toBe("⚙");
    expect(button?.getAttribute("title")).toBe("高级设置");
    expect(button?.classList.contains("icon-button")).toBe(true);
    expect(button?.disabled).toBe(false);
    expect(button?.tabIndex).toBe(0);
    button?.focus();
    expect(document.activeElement).toBe(button);
  });

});

// #184：AppShell 本体此前从未被渲染，6 个变异点全是 uncovered。下面几条按「外壳把哪个开关
// 接到哪个子组件」断言，命中 appShell.tsx 里内嵌在 JSX 中的 && / === / !== / !。
describe("工作台外壳的接线", () => {
  const viewOf = (patch: Partial<AppView> = {}): AppView => ({
    active: undefined, openState: "ok", activeArchived: false, archived: null, failures: [],
    undoLabel: null, redoLabel: null, boardNotice: null, exportDisabled: null,
    downloadDisabled: null, importDisabled: null, titleOf: () => "a", ...patch,
  });
  const indicator = { active: [], activity: { busy: false, pending: 0, reading: 0, waiting: 0, running: 0, backoff: 0, boards: [] }, titleOf: () => "", onJump: vi.fn(), onCancelCopy: vi.fn(), onCancelWaiting: vi.fn() };

  const shell = (patch: Partial<ComponentProps<typeof AppShell>> = {}): ComponentProps<typeof AppShell> => ({
    view: viewOf(), sessions: [], activeKey: null, userRoot: "/root", ready: true, version: "1.0",
    updateNotice: null, packMenu: null, boardListOpen: false, manageBoards: false, settingsLoaded: true,
    runIndicator: indicator, updateStatus: updateStatusView({ snapshot: emptySnapshot(), auto: IDLE_AUTO_VIEW }), onOpenFeedback: vi.fn(), update: updateControl(), theme: themeControl(),
    onDeferUpdate: vi.fn(), tableError: null, settingsFileProblem: null, settingsOpen: false,
    usageNotice: null, canvasProps: {} as never,
    onActivate: vi.fn(), onCloseTab: vi.fn(), onRename: vi.fn(), onCreate: vi.fn(), onOpenList: vi.fn(),
    onExportPack: vi.fn(), onOpenChangelog: vi.fn(), onCloseUpdateNotice: vi.fn(), onOpenListItem: vi.fn(),
    onCloseBoardList: vi.fn(), onDeleteBoard: vi.fn(), onArchiveBoard: vi.fn(), onUnarchiveBoard: vi.fn(),
    onCopyBoard: vi.fn(), onExportBoard: vi.fn(), onTogglePackMenu: vi.fn(), onPackMenuPick: vi.fn(),
    onPackMenuClose: vi.fn(), onDismissTableError: vi.fn(), onOpenSettings: vi.fn(), onManageBoards: vi.fn(),
    onDismissUsage: vi.fn(), onUnarchive: vi.fn(),
    onCopyArchived: vi.fn(), onDismissBoardNotice: vi.fn(), onReload: vi.fn(), onRetrySave: vi.fn(),
    onExportFailure: vi.fn(), onCloseMissing: vi.fn(), onImportPack: vi.fn(), importDisabled: null,
    onToolbarSlot: vi.fn(), ...patch,
  });
  const show = async (port: FakePort, patch: Partial<ComponentProps<typeof AppShell>> = {}): Promise<void> =>
    act(async () => dom.render(createElement(ShellProvider, { port, children: createElement(AppShell, shell(patch)) })));

  it("画板列表只在「打开了列表」且「有数据根」时挂载", async () => {
    const dialog = () => container.querySelector('[role="dialog"][aria-label="画板列表"]');
    await show(createFakePort(), { boardListOpen: true });
    expect(dialog()).not.toBeNull();
    await show(createFakePort(), { boardListOpen: true, userRoot: null });
    expect(dialog()).toBeNull();
    await show(createFakePort(), { boardListOpen: false });
    expect(dialog()).toBeNull();
  });

  it("画板包菜单只在有位置时挂载", async () => {
    await show(createFakePort(), { packMenu: { x: 1, y: 2 } });
    expect(container.textContent).toContain("导出画板包…");
    await show(createFakePort(), { packMenu: null });
    expect(container.textContent).not.toContain("导出画板包…");
  });

  it("画布就绪与否决定工具栏占位", async () => {
    const slot = () => container.querySelector(".board-toolbar-slot");
    await show(createFakePort(), { view: viewOf({ openState: "ok" }) });
    expect(slot()?.querySelector('[role="toolbar"]')).toBeNull();
    await show(createFakePort(), { view: viewOf({ openState: "none" }) });
    expect(slot()?.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("画板工具栏");
    const prompt = [...(slot()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("＋ 提示词"));
    expect(prompt?.getAttribute("aria-disabled")).toBe("true");
  });

  it("没有数据根时画板包菜单按钮禁用，有则可用", async () => {
    const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await show(createFakePort(), { userRoot: null });
    expect(toggle().disabled).toBe(true);
    await show(createFakePort(), { userRoot: "/root" });
    expect(toggle().disabled).toBe(false);
  });

  it("菜单开合反映在 aria-expanded 上", async () => {
    const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await show(createFakePort(), { packMenu: { x: 1, y: 2 } });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await show(createFakePort(), { packMenu: null });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});
