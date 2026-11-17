// 工作台的界面外壳（#137）：从 src/App.tsx 拆出的子组件。
// App 只留状态与接线，界面外壳在这里按各区块渲染。
import type { ComponentProps } from "react";
import { AppBoardList, AppPackMenu, AppToolbar, AppTopBar, AppWorkspace } from "./appPanels";
import { AppNotices } from "./appNotices";
import { BackupHint } from "./appBars";
import type { AppView } from "./appView";
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
  onCloseUpdateNotice(): void;
  onOpenListItem(path: string): void;
  onCloseBoardList(): void;
  onDeleteBoard(path: string): Promise<void>;
  onArchiveBoard(path: string): Promise<void>;
  onUnarchiveBoard(path: string): Promise<string | null>;
  onCopyBoard(path: string): Promise<string | null>;
  onExportBoard(path: string): void;
  onTogglePackMenu(at: { x: number; y: number }): void;
  onPackMenuPick(action: "importPack" | "exportPack" | "downloadResults"): void;
  onPackMenuClose(): void;
  onDismissTableError(): void;
  onOpenSettings(): void;
  onManageBoards(): void;
  onDismissUsage(): void;
  onTidy(): void;
  onDismissSize(): void;
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
  return (
    <div className="app">
      <AppTopBar
        sessions={sessions}
        activeKey={activeKey}
        onActivate={props.onActivate}
        onClose={props.onCloseTab}
        onRename={props.onRename}
        onCreate={props.onCreate}
        onOpenList={props.onOpenList}
        onExportPack={props.onExportPack}
        updateNotice={props.updateNotice}
        onOpenChangelog={props.onOpenChangelog}
        onCloseUpdateNotice={props.onCloseUpdateNotice}
        backupHint={<BackupHint />}
      />
      {props.boardListOpen && userRoot && (
        <AppBoardList
          openPaths={sessions.map((s) => s.path)}
          manage={props.manageBoards}
          onOpen={props.onOpenListItem}
          onDelete={props.onDeleteBoard}
          onArchive={props.onArchiveBoard}
          onUnarchive={props.onUnarchiveBoard}
          onCopy={props.onCopyBoard}
          onExport={props.onExportBoard}
          onClose={props.onCloseBoardList}
        />
      )}
      <AppToolbar
        setToolbarSlot={props.onToolbarSlot}
        canvasReady={view.openState === "ok"}
        runIndicator={props.runIndicator}
        packMenuOpen={props.packMenu !== null}
        packMenuDisabled={!userRoot}
        onTogglePackMenu={props.onTogglePackMenu}
        version={props.version}
        ready={ready}
        onOpenChangelog={props.onOpenChangelog}
        settingsLoaded={props.settingsLoaded}
        onOpenSettings={props.onOpenSettings}
      />
      {props.packMenu && (
        <AppPackMenu
          at={props.packMenu}
          importDisabledReason={props.importDisabled}
          exportDisabledReason={view.exportDisabled}
          downloadDisabledReason={view.downloadDisabled}
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
        sizeNotice={view.sizeNotice}
        activeArchived={view.activeArchived}
        boardNotice={view.boardNotice}
        onDismissTableError={props.onDismissTableError}
        onOpenSettings={props.onOpenSettings}
        onManageBoards={props.onManageBoards}
        onDismissUsage={props.onDismissUsage}
        onTidy={props.onTidy}
        onDismissSize={props.onDismissSize}
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
