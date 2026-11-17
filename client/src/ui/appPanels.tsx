// 工作台各个区块的子组件（#137）：从 src/App.tsx 拆出，让 App 只留接线与状态。
import type { ComponentProps, ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { BoardCanvas } from "./BoardCanvas";
import { BoardListDialog } from "./BoardListDialog";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { BoardToolbar } from "./BoardToolbar";
import { ContextMenu } from "./ContextMenu";
import { RunIndicator } from "./RunIndicator";
import { TabBar } from "./TabBar";
import type { Session } from "./useBoardSessions";

/** 顶栏：备份提示、标签页与「已更新」提示条。 */
export function AppTopBar({
  sessions,
  activeKey,
  onActivate,
  onClose,
  onRename,
  onCreate,
  onOpenList,
  onExportPack,
  updateNotice,
  onOpenChangelog,
  onCloseUpdateNotice,
  backupHint,
}: {
  sessions: Session[];
  activeKey: string | null;
  onActivate(key: string): void;
  onClose(key: string): void;
  onRename(key: string, title: string): void;
  onCreate(): void;
  onOpenList(): void;
  onExportPack(key: string): void;
  /** 有新版本且用户还没看过：显示更新提示条。 */
  updateNotice: string | null;
  onOpenChangelog(): void;
  onCloseUpdateNotice(): void;
  backupHint: ReactNode;
}) {
  return (
    <>
      <div className="topbar">
        {backupHint}
        <TabBar
          sessions={sessions}
          activeKey={activeKey}
          onActivate={onActivate}
          onClose={onClose}
          onRename={onRename}
          onCreate={onCreate}
          onOpenList={onOpenList}
          onExportPack={onExportPack}
        />
      </div>
      {updateNotice && (
        <div className="bar update-notice" role="status">
          <span>已更新到 {updateNotice}</span>
          <button onClick={onOpenChangelog}>看看改了什么</button>
          <button className="link" onClick={onCloseUpdateNotice} aria-label="关闭更新提示">关闭</button>
        </div>
      )}
    </>
  );
}

/** 画板列表对话框（用量提醒的「管理画板」入口也走这里）。 */
export function AppBoardList({
  openPaths,
  manage,
  onOpen,
  onDelete,
  onArchive,
  onUnarchive,
  onCopy,
  onExport,
  onClose,
}: {
  openPaths: string[];
  manage: boolean;
  onOpen(path: string): void;
  onDelete(path: string): Promise<void>;
  onArchive(path: string): Promise<void>;
  onUnarchive(path: string): Promise<string | null>;
  onCopy(path: string): Promise<string | null>;
  onExport(path: string): void;
  onClose(): void;
}) {
  return (
    <BoardListDialog
      openPaths={openPaths}
      onOpen={onOpen}
      onDelete={onDelete}
      onArchive={onArchive}
      onUnarchive={onUnarchive}
      onCopy={onCopy}
      onExport={onExport}
      onClose={onClose}
      manage={manage}
    />
  );
}

/** 工具栏那一行：运行指示、画板包菜单、版本、设置与退出。 */
export function AppToolbar({
  setToolbarSlot,
  canvasReady,
  runIndicator,
  packMenuOpen,
  packMenuDisabled,
  onTogglePackMenu,
  version,
  ready,
  onOpenChangelog,
  settingsLoaded,
  onOpenSettings,
}: {
  /** 画布把工具栏 portal 进这个容器。 */
  setToolbarSlot(slot: HTMLElement | null): void;
  canvasReady: boolean;
  runIndicator: ComponentProps<typeof RunIndicator>;
  packMenuOpen: boolean;
  /** 没有数据根时画板包入口不可用。 */
  packMenuDisabled: boolean;
  /** 打开菜单时给它的位置（按钮下缘）。 */
  onTogglePackMenu(at: { x: number; y: number }): void;
  version: string | null;
  ready: boolean;
  onOpenChangelog(): void;
  settingsLoaded: boolean;
  onOpenSettings(): void;
}) {
  return (
    <div className="board-toolbar">
      {/* 有画板时画布把工具栏 portal 进这个容器；没有时放置灰占位，布局不跳。 */}
      <div ref={setToolbarSlot} className="board-toolbar-slot">
        {!canvasReady && <BoardToolbar disabled />}
      </div>
      <div className="board-toolbar-right">
        <RunIndicator {...runIndicator} />
        <button
          className="topbar-button"
          aria-haspopup="menu"
          aria-expanded={packMenuOpen}
          disabled={packMenuDisabled}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onTogglePackMenu({ x: r.left, y: r.bottom + 2 });
          }}
        >
          画板包 ▾
        </button>
        {version && <button className="topbar-button topbar-version" onClick={onOpenChangelog} disabled={!ready} aria-haspopup="dialog" title="查看更新内容">Kacha {version}</button>}
        <button className="topbar-button" onClick={onOpenSettings} disabled={!settingsLoaded}>
          ⚙ 高级设置
        </button>
      </div>
    </div>
  );
}

/** 画板包菜单：导入、导出、下载整板结果。 */
export function AppPackMenu({
  at,
  importDisabledReason,
  exportDisabledReason,
  downloadDisabledReason,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  /** 导入画板包的置灰原因（端口说这项能力还没有时非空）。 */
  importDisabledReason: string | null;
  exportDisabledReason: string | null;
  downloadDisabledReason: string | null;
  onPick(action: "importPack" | "exportPack" | "downloadResults"): void;
  onClose(): void;
}) {
  return (
    <ContextMenu
      at={at}
      items={[
        { action: "importPack", label: importDisabledReason ? "导入画板包…（" + UNAVAILABLE_TEXT + "）" : "导入画板包…", disabledReason: importDisabledReason },
        { action: "exportPack", label: "导出画板包…", disabledReason: exportDisabledReason },
        { action: "downloadResults" as const, label: "下载整板结果（zip）", disabledReason: downloadDisabledReason },
      ]}
      onPick={(action) => onPick(action as "importPack" | "exportPack" | "downloadResults")}
      onClose={onClose}
    />
  );
}

/** 工作区：没有画板 / 画板版本太新 / 画板损坏 / 正常画布。 */
export function AppWorkspace({
  active,
  userRoot,
  ready,
  onCreate,
  onImportPack,
  importDisabled,
  canvasProps,
}: {
  /** 当前画板会话；没有为 undefined。 */
  active: Session | undefined;
  userRoot: string | null;
  ready: boolean;
  onCreate(): void;
  onImportPack(): void;
  /** 导入画板包的置灰原因（端口说这项能力还没有时非空）。 */
  importDisabled: string | null;
  canvasProps: ComponentProps<typeof BoardCanvas>;
}) {
  if (!active || !userRoot) {
    return (
      <div className="empty">
        {ready ? (
          <>
            <div>没有打开的画板</div>
            <div className="empty-actions">
              <button className="primary" onClick={onCreate} disabled={!userRoot}>
                新建画板
              </button>
              <button onClick={onImportPack} disabled={!userRoot || importDisabled !== null} title={importDisabled ?? undefined}>
                导入画板包…{importDisabled ? "（" + UNAVAILABLE_TEXT + "）" : ""}
              </button>
            </div>
          </>
        ) : (
          "正在加载…"
        )}
      </div>
    );
  }
  if (active.status === "newer") {
    return (
      <div className="empty">
        该画板由更新版本的工具保存（format_version {active.version}），本版本无法打开；文件未做任何改动。
        <div className="mono muted">{active.path}</div>
      </div>
    );
  }
  if (active.status === "corrupt") {
    return (
      <div className="empty">
        画板文件已损坏且没有可用备份：{active.reason}
        <div className="mono muted">{active.path}</div>
      </div>
    );
  }
  return (
    <ReactFlowProvider key={active.key}>
      <BoardCanvas {...canvasProps} />
    </ReactFlowProvider>
  );
}
