// 工作台各个区块的子组件（#137）：从 src/App.tsx 拆出，让 App 只留接线与状态。
import type { ComponentProps } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { BoardCanvas } from "./BoardCanvas";
import { BoardListDialog } from "./BoardListDialog";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { BoardToolbar } from "./BoardToolbar";
import { ContextMenu } from "./ContextMenu";
import { RunIndicator } from "./RunIndicator";
import { TabBar } from "./TabBar";
import { ThemeSwitch } from "./ThemeSwitch";
import { UpdateToolbarControl } from "./UpdateToolbarControl";
import type { ThemeControl } from "./useTheme";
import type { UpdateControl } from "./useUpdate";
import type { Session } from "./useBoardSessions";

/** 顶栏：标签页与「已更新」提示条。 */
export function AppTopBar({
  sessions,
  activeKey,
  onActivate,
  onClose,
  onRename,
  onCreate,
  onExportPack,
  updateNotice,
  onOpenChangelog,
  onCloseUpdateNotice,
}: {
  sessions: Session[];
  activeKey: string | null;
  onActivate(key: string): void;
  onClose(key: string): void;
  onRename(key: string, title: string): void;
  onCreate(): void;
  onExportPack(key: string): void;
  /** 有新版本且用户还没看过：显示更新提示条。 */
  updateNotice: string | null;
  onOpenChangelog(): void;
  onCloseUpdateNotice(): void;
}) {
  return (
    <>
      <div className="topbar">
        <TabBar
          sessions={sessions}
          activeKey={activeKey}
          onActivate={onActivate}
          onClose={onClose}
          onRename={onRename}
          onCreate={onCreate}
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
  at,
  trigger,
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
  /** 弹层锚点（触发按钮的左下角，视口坐标）。 */
  at: { x: number; y: number } | null;
  /** 触发元素；点它不算「点外部」，关闭后焦点回到这里。 */
  trigger: HTMLElement | null;
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
      at={at}
      trigger={trigger}
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
  boardListOpen,
  onTogglePackMenu,
  onOpenList,
  version,
  ready,
  onOpenChangelog,
  settingsLoaded,
  onOpenSettings,
  onOpenFeedback,
  feedbackAvailable = true,
  update,
  theme,
}: {
  /** 画布把工具栏 portal 进这个容器。 */
  setToolbarSlot(slot: HTMLElement | null): void;
  canvasReady: boolean;
  runIndicator: ComponentProps<typeof RunIndicator>;
  packMenuOpen: boolean;
  /** 没有数据根时画板包入口不可用。 */
  packMenuDisabled: boolean;
  /** 画板列表入口的展开态；弹层与入口共用同一份状态。 */
  boardListOpen: boolean;
  /** 打开菜单时给它的位置（按钮下缘）。 */
  onTogglePackMenu(at: { x: number; y: number }): void;
  /** 从第二行右侧入口打开画板列表弹层，传入触发元素供锚定与关闭后还焦点。 */
  onOpenList(trigger: HTMLElement): void;
  version: string | null;
  ready: boolean;
  onOpenChangelog(): void;
  settingsLoaded: boolean;
  onOpenSettings(): void;
  /** 首屏反馈入口（#206）；能力关闭时仍保留入口文案并用重试打开对话框。 */
  onOpenFeedback(): void;
  /** 端口的能力开关：关闭时入口明确标暂不可用，不假装可用。 */
  feedbackAvailable?: boolean;
  /** 更新入口的接线（#181）：首页版本号旁的那一份，与高级设置共用同一份快照与动作。 */
  update: UpdateControl;
  /** 主题切换入口的接线（#221）：档位与切换动作来自 App。 */
  theme: ThemeControl;
}) {
  return (
    <div className="board-toolbar">
      {/* 有画板时画布把工具栏 portal 进这个容器；没有时放置灰占位，布局不跳。 */}
      <div ref={setToolbarSlot} className="board-toolbar-slot">
        {!canvasReady && <BoardToolbar disabled />}
      </div>
      <div className="board-toolbar-right">
        <button
          className="topbar-button board-list-toggle"
          aria-haspopup="dialog"
          aria-expanded={boardListOpen}
          title="列出本机存储已有画板并打开"
          onClick={(e) => onOpenList(e.currentTarget)}
        >
          画板列表
        </button>
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
        <UpdateToolbarControl {...update} />
        <button className="topbar-button" onClick={onOpenFeedback} aria-haspopup="dialog" title={feedbackAvailable ? "提交反馈" : "反馈暂不可用，点击重试"}>
          {feedbackAvailable ? "反馈" : "反馈（暂不可用）"}
        </button>
        {/* 主题切换（#221）：常驻紧凑入口，点击即时生效，不进设置面板。 */}
        <ThemeSwitch choice={theme.choice} onChoose={theme.choose} />
        <button
          type="button"
          className="icon-button"
          aria-label="高级设置"
          title="高级设置"
          aria-haspopup="dialog"
          onClick={onOpenSettings}
          disabled={!settingsLoaded}
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

/** 画板包菜单：导入与导出。 */
export function AppPackMenu({
  at,
  importDisabledReason,
  exportDisabledReason,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  /** 导入画板包的置灰原因（端口说这项能力还没有时非空）。 */
  importDisabledReason: string | null;
  exportDisabledReason: string | null;
  onPick(action: "importPack" | "exportPack"): void;
  onClose(): void;
}) {
  return (
    <ContextMenu
      at={at}
      items={[
        { action: "importPack", label: importDisabledReason ? "导入画板包…（" + UNAVAILABLE_TEXT + "）" : "导入画板包…", disabledReason: importDisabledReason },
        { action: "exportPack", label: "导出画板包…", disabledReason: exportDisabledReason },
      ]}
      onPick={(action) => onPick(action as "importPack" | "exportPack")}
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
