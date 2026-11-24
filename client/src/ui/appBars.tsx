// 工作台顶部的提示条（#137）：从 src/App.tsx 拆出的子组件，让 App 只留接线。
import type { Board } from "../core/board";
import type { SizeTier } from "../core/boardSize";
import { ARCHIVE_TEXT, MANAGE_BOARDS_TEXT, usageLimitText } from "./boardText";
import { saveFailureNotice } from "./appUiState";
import type { UpdateStatusView } from "./updateStatusView";

/** 保存失败的画板：说明与操作按钮。 */
export function SaveFailureBar({
  board,
  saveError,
  missing,
  conflicted,
  onReload,
  onRetry,
  onExport,
  onClose,
}: {
  board: Board;
  saveError: string;
  missing: boolean;
  conflicted: boolean;
  onReload(): void;
  onRetry(): void;
  onExport(): void;
  onClose(): void;
}) {
  const notice = saveFailureNotice({ saveError, missing, conflicted });
  return (
    <div className="bar bar-error">
      <span>
        「{board.title}」{saveError}
        {notice.note}
      </span>
      {notice.actions.includes("reload") && <button onClick={onReload}>重新载入</button>}
      {notice.actions.includes("retry") && <button onClick={onRetry}>重试保存</button>}
      {notice.actions.includes("export") && <button onClick={onExport}>导出画板包</button>}
      {notice.actions.includes("close") && <button onClick={onClose}>关闭</button>}
    </div>
  );
}

/** 用量上限提醒：只提醒，生成照常。 */
export function UsageLimitBar({
  level,
  total,
  limit,
  onManage,
  onDismiss,
}: {
  level: SizeTier;
  total: number;
  limit: number;
  onManage(): void;
  onDismiss(): void;
}) {
  return (
    <div className={`bar ${level === "alert" ? "bar-alert" : "bar-warn"} usage-limit-notice`} role="status" data-usage-level={level}>
      <span>{usageLimitText(level, total, limit)}</span>
      <button onClick={onManage}>{MANAGE_BOARDS_TEXT}</button>
      <button className="link" aria-label="关闭用量提醒" onClick={onDismiss}>
        关闭
      </button>
    </div>
  );
}

/** 归档画板的只读横条：能看、能放大、能下载结果与导出画板包。 */
export function ArchivedBar({ onUnarchive, onCopy }: { onUnarchive(): void; onCopy(): void }) {
  return (
    <div className="bar bar-info archived-notice" role="status">
      <span>{ARCHIVE_TEXT.banner}</span>
      <button onClick={onUnarchive}>{ARCHIVE_TEXT.unarchive}</button>
      <button onClick={onCopy}>{ARCHIVE_TEXT.copy}</button>
    </div>
  );
}

/**
 * 更新状态提示条（#180）：发现新版本、下载进度与自动安装倒计时都在主界面看得见，
 * 不必打开高级设置。位置与观感跟其它提示条一致，不另起一套视觉。
 */
export function UpdateStatusBar({ view, onDefer }: { view: UpdateStatusView; onDefer(): void }) {
  return (
    <div className="bar bar-info update-status" role="status" data-update-phase={view.phase}>
      <span>{view.text}</span>
      {view.canDefer && <button onClick={onDefer}>稍后</button>}
    </div>
  );
}
