// 工作台的提示条（#137）：从 src/App.tsx 拆出的子组件，让 App 只留接线。
import type { Board } from "../core/board";
import type { SizeTier } from "../core/boardSize";
import { ArchivedBar, SaveFailureBar, SizeNoticeBar, UsageLimitBar } from "./appBars";

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
  /** 当前画板的体量提示。 */
  sizeNotice: { bytes: number; tier: SizeTier } | null;
  /** 当前画板是归档画板（只读，不能整理）。 */
  activeArchived: boolean;
  /** 当前画板自己的提示（重命名失败、重新载入失败等）。 */
  boardNotice: string | null;
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
  onExportPack(key: string): void;
  onCloseMissing(key: string): void;
}

/** 工作台的所有提示条。 */
export function AppNotices(props: AppNoticesProps) {
  const { failures, tableError, settingsFileProblem, settingsOpen, usageNotice, sizeNotice, activeArchived, boardNotice } = props;
  return (
    <>
      {failures.map((f) => (
        <SaveFailureBar
          key={f.key}
          board={f.board}
          saveError={f.saveError}
          missing={f.missing}
          conflicted={f.conflicted}
          onReload={() => props.onReload(f.key)}
          onRetry={() => props.onRetrySave(f.key)}
          onExport={() => props.onExportPack(f.key)}
          onClose={() => props.onCloseMissing(f.key)}
        />
      ))}
      {tableError && (
        <div className="bar bar-warn">
          <span>{tableError}（已使用内置能力表）</span>
          <button onClick={props.onDismissTableError}>知道了</button>
        </div>
      )}
      {settingsFileProblem && !settingsOpen && (
        <div className="bar bar-warn">
          <span>{settingsFileProblem}</span>
          <button onClick={props.onOpenSettings}>打开高级设置</button>
        </div>
      )}
      {usageNotice && (
        <UsageLimitBar
          level={usageNotice.level}
          total={usageNotice.total}
          limit={usageNotice.limit}
          onManage={props.onManageBoards}
          onDismiss={props.onDismissUsage}
        />
      )}
      {sizeNotice && (
        <SizeNoticeBar
          bytes={sizeNotice.bytes}
          tier={sizeNotice.tier}
          canTidy={!activeArchived}
          onTidy={props.onTidy}
          onDismiss={props.onDismissSize}
        />
      )}
      {activeArchived && (
        <ArchivedBar onUnarchive={props.onUnarchive} onCopy={props.onCopyArchived} />
      )}
      {boardNotice && (
        <div className="bar bar-warn">
          <span>{boardNotice}</span>
          <button onClick={props.onDismissBoardNotice}>知道了</button>
        </div>
      )}
    </>
  );
}
