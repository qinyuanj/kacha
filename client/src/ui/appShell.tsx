// 工作台的界面外壳（#137）：从 src/App.tsx 拆出的子组件。
// App 只留状态与接线，界面外壳在这里按各区块渲染。
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { AppBoardList, AppPackMenu, AppToolbar, AppTopBar, AppWorkspace } from "./appPanels";
import { AppNotices } from "./appNotices";
import type { AppView } from "./appView";
import type { UpdateStatusView } from "./updateStatusView";
import type { ThemeControl } from "./useTheme";
import type { UpdateControl } from "./useUpdate";
import type { Session } from "./useBoardSessions";

/** 工作台的外壳：顶栏、画板列表、工具栏、提示条与工作区。 */
export function AppShell(props: {
  view: AppView;
  sessions: Session[];
  activeKey: string | null;
  userRoot: string | null;
  ready: boolean;
  version: string | null;
  updateNotice: string | null;
  packMenu: { x: number; y: number } | null;
  boardListOpen: boolean;
  manageBoards: boolean;
  settingsLoaded: boolean;
  runIndicator: ComponentProps<typeof AppToolbar>["runIndicator"];
  /** 更新状态提示条（#180）。 */
  updateStatus: UpdateStatusView;
  /** 更新入口的接线（#181）：首页版本号旁的检查与安装。 */
  update: UpdateControl;
  /** 主题切换入口的接线（#221）。 */
  theme: ThemeControl;
  onDeferUpdate(): void;
  /** 提示条要的参数。 */
  tableError: string | null;
  settingsFileProblem: string | null;
  settingsOpen: boolean;
  usageNotice: { level: "warn" | "alert"; total: number; limit: number } | null;
  canvasProps: ComponentProps<typeof AppWorkspace>["canvasProps"];
  onActivate(key: string): void;
  onCloseTab(key: string): void;
  onRename(key: string, title: string): void;
  onCreate(): void;
  onOpenList(): void;
  onExportPack(key: string): void;
  onOpenChangelog(): void;
  onOpenFeedback(): void;
  /** 反馈能力开关（#206）：关闭时入口标暂不可用。 */
  feedbackAvailable?: boolean;
  onCloseUpdateNotice(): void;
  onOpenListItem(path: string): void;
  onCloseBoardList(): void;
  onDeleteBoard(path: string): Promise<void>;
  onArchiveBoard(path: string): Promise<void>;
  onUnarchiveBoard(path: string): Promise<string | null>;
  onCopyBoard(path: string): Promise<string | null>;
  onExportBoard(path: string): void;
  onTogglePackMenu(at: { x: number; y: number }): void;
  onPackMenuPick(action: "importPack" | "exportPack"): void;
  onPackMenuClose(): void;
  onDismissTableError(): void;
  onOpenSettings(): void;
  onManageBoards(): void;
  onDismissUsage(): void;
  onUnarchive(): void;
  onCopyArchived(): void;
  onDismissBoardNotice(): void;
  onReload(key: string): void;
  onRetrySave(key: string): void;
  onExportFailure(key: string): void;
  onCloseMissing(key: string): void;
  onImportPack(): void;
  /** 导入画板包的置灰原因（端口说这项能力还没有时非空）。 */
  importDisabled: string | null;
  onToolbarSlot(slot: HTMLElement | null): void;
}) {
  const { view, sessions, activeKey, userRoot, ready } = props;
  const [boardListAnchor, setBoardListAnchor] = useState<{ x: number; y: number } | null>(null);
  const boardListTrigger = useRef<HTMLElement | null>(null);
  const openBoardListAt = useCallback((trigger: HTMLElement, manage: boolean) => {
    const rect = trigger.getBoundingClientRect();
    boardListTrigger.current = trigger;
    setBoardListAnchor({ x: rect.left, y: rect.bottom + 2 });
    if (manage) props.onManageBoards();
    else props.onOpenList();
  }, [props.onManageBoards, props.onOpenList]);
  const closeBoardList = useCallback(() => {
    props.onCloseBoardList();
    const trigger = boardListTrigger.current;
    boardListTrigger.current = null;
    if (trigger?.isConnected) trigger.focus();
  }, [props.onCloseBoardList]);
  return (
    <div className="app">
      <AppTopBar
        sessions={sessions}
        activeKey={activeKey}
        onActivate={props.onActivate}
        onClose={props.onCloseTab}
        onRename={props.onRename}
        onCreate={props.onCreate}
        onExportPack={props.onExportPack}
        updateNotice={props.updateNotice}
        onOpenChangelog={props.onOpenChangelog}
        onCloseUpdateNotice={props.onCloseUpdateNotice}
      />
      <AppToolbar
        setToolbarSlot={props.onToolbarSlot}
        canvasReady={view.openState === "ok"}
        runIndicator={props.runIndicator}
        packMenuOpen={props.packMenu !== null}
        packMenuDisabled={!userRoot}
        boardListOpen={props.boardListOpen}
        onTogglePackMenu={props.onTogglePackMenu}
        onOpenList={(trigger) => openBoardListAt(trigger, false)}
        version={props.version}
        onOpenChangelog={props.onOpenChangelog}
        onOpenFeedback={props.onOpenFeedback}
        feedbackAvailable={props.feedbackAvailable ?? true}
        settingsLoaded={props.settingsLoaded}
        onOpenSettings={props.onOpenSettings}
        update={props.update}
        theme={props.theme}
      />
      {props.boardListOpen && userRoot && (
        <AppBoardList
          openPaths={sessions.map((s) => s.path)}
          manage={props.manageBoards}
          at={boardListAnchor}
          trigger={boardListTrigger.current}
          onOpen={props.onOpenListItem}
          onDelete={props.onDeleteBoard}
          onArchive={props.onArchiveBoard}
          onUnarchive={props.onUnarchiveBoard}
          onCopy={props.onCopyBoard}
          onExport={props.onExportBoard}
          onClose={closeBoardList}
        />
      )}
      {props.packMenu && (
        <AppPackMenu
          at={props.packMenu}
          importDisabledReason={props.importDisabled}
          exportDisabledReason={view.exportDisabled}
          onPick={props.onPackMenuPick}
          onClose={props.onPackMenuClose}
        />
      )}
      <AppNotices
        failures={view.failures}
        tableError={props.tableError}
        settingsFileProblem={props.settingsFileProblem}
        settingsOpen={props.settingsOpen}
        usageNotice={props.usageNotice}
        activeArchived={view.activeArchived}
        boardNotice={view.boardNotice}
        updateStatus={props.updateStatus}
        onDeferUpdate={props.onDeferUpdate}
        onDismissTableError={props.onDismissTableError}
        onOpenSettings={props.onOpenSettings}
        onManageBoards={(trigger) => openBoardListAt(trigger, true)}
        onDismissUsage={props.onDismissUsage}
        onUnarchive={props.onUnarchive}
        onCopyArchived={props.onCopyArchived}
        onDismissBoardNotice={props.onDismissBoardNotice}
        onReload={props.onReload}
        onRetrySave={props.onRetrySave}
        onExportPack={props.onExportFailure}
        onCloseMissing={props.onCloseMissing}
      />
      <main className="workspace">
        <AppWorkspace
          active={view.active}
          userRoot={userRoot}
          ready={ready}
          onCreate={props.onCreate}
          onImportPack={props.onImportPack}
          importDisabled={props.importDisabled}
          canvasProps={props.canvasProps}
        />
      </main>
    </div>
  );
}
