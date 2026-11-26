// 工作台的提示条（#137）：从 src/App.tsx 拆出的子组件，让 App 只留接线。
import type { Board } from "../core/board";
import type { SizeTier } from "../core/boardSize";
import { ArchivedBar, SaveFailureBar, UpdateStatusBar, UsageLimitBar } from "./appBars";
import type { UpdateStatusView } from "./updateStatusView";

/** 保存失败的画板：说明与操作按钮。 */
export interface SaveFailure {
  key: string;
  board: Board;
  saveError: string;
  missing: boolean;
  conflicted: boolean;
}

/** 各条提示条要用的东西。 */
export interface AppNoticesProps {
  /** 保存失败的画板。 */
  failures: SaveFailure[];
  /** 能力表覆盖文件读失败（或内容无效）的说明。 */
  tableError: string | null;
  /** 设置文件的问题（newer / 读不到 / 损坏）。 */
  settingsFileProblem: string | null;
  /** 设置面板开着时不重复提示。 */
  settingsOpen: boolean;
  /** 用量提醒。 */
  usageNotice: { level: SizeTier; total: number; limit: number } | null;
  /** 当前画板是归档画板（只读）。 */
  activeArchived: boolean;
  /** 当前画板自己的提示（重命名失败、重新载入失败等）。 */
  boardNotice: string | null;
  /** 更新状态提示条（#180）：发现 / 下载中 / 已就绪都在主界面看得见。 */
  updateStatus: UpdateStatusView;
  onDismissTableError(): void;
  onOpenSettings(): void;
  onManageBoards(trigger: HTMLElement): void;
  onDismissUsage(): void;
  onUnarchive(): void;
  onCopyArchived(): void;
  onDismissBoardNotice(): void;
  /** 更新倒计时里的「稍后」：本轮不再自动装。 */
  onDeferUpdate(): void;
  onReload(key: string): void;
  onRetrySave(key: string): void;
  onExportPack(key: string): void;
  onCloseMissing(key: string): void;
}

/** 保存失败的那些画板。 */
function SaveFailures({ failures, onReload, onRetrySave, onExportPack, onCloseMissing }: { failures: SaveFailure[] } & Pick<AppNoticesProps, "onReload" | "onRetrySave" | "onExportPack" | "onCloseMissing">) {
  return (
    <>
      {failures.map((f) => (
        <SaveFailureBar
          key={f.key}
          board={f.board}
          saveError={f.saveError}
          missing={f.missing}
          conflicted={f.conflicted}
          onReload={() => onReload(f.key)}
          onRetry={() => onRetrySave(f.key)}
          onExport={() => onExportPack(f.key)}
          onClose={() => onCloseMissing(f.key)}
        />
      ))}
    </>
  );
}

/** 能力表与设置文件的问题提示。 */
function ConfigWarnings({ tableError, settingsFileProblem, settingsOpen, onDismissTableError, onOpenSettings }: { tableError: string | null; settingsFileProblem: string | null; settingsOpen: boolean } & Pick<AppNoticesProps, "onDismissTableError" | "onOpenSettings">) {
  return (
    <>
      {tableError && (
        <div className="bar bar-warn">
          <span>{tableError}（已使用内置能力表）</span>
          <button onClick={onDismissTableError}>知道了</button>
        </div>
      )}
      {settingsFileProblem && !settingsOpen && (
        <div className="bar bar-warn">
          <span>{settingsFileProblem}</span>
          <button onClick={onOpenSettings}>打开高级设置</button>
        </div>
      )}
    </>
  );
}

/** 工作台的所有提示条。 */
export function AppNotices(props: AppNoticesProps) {
  const { failures, tableError, settingsFileProblem, settingsOpen, usageNotice, activeArchived, boardNotice } = props;
  return (
    <>
      {props.updateStatus.visible && <UpdateStatusBar view={props.updateStatus} onDefer={props.onDeferUpdate} />}
      <SaveFailures
        failures={failures}
        onReload={props.onReload}
        onRetrySave={props.onRetrySave}
        onExportPack={props.onExportPack}
        onCloseMissing={props.onCloseMissing}
      />
      <ConfigWarnings
        tableError={tableError}
        settingsFileProblem={settingsFileProblem}
        settingsOpen={settingsOpen}
        onDismissTableError={props.onDismissTableError}
        onOpenSettings={props.onOpenSettings}
      />
      {usageNotice && (
        <UsageLimitBar
          level={usageNotice.level}
          total={usageNotice.total}
          limit={usageNotice.limit}
          onManage={props.onManageBoards}
          onDismiss={props.onDismissUsage}
        />
      )}
      {activeArchived && <ArchivedBar onUnarchive={props.onUnarchive} onCopy={props.onCopyArchived} />}
      {boardNotice && (
        <div className="bar bar-warn">
          <span>{boardNotice}</span>
          <button onClick={props.onDismissBoardNotice}>知道了</button>
        </div>
      )}
    </>
  );
}
