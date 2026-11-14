// 工作台顶部的提示条（#137）：从 src/App.tsx 拆出的子组件，让 App 只留接线。
import type { Board } from "../core/board";
import type { SizeTier } from "../core/boardSize";
import { ARCHIVE_TEXT, BACKUP_HINT_TEXT, MANAGE_BOARDS_TEXT, sizeNoticeText, usageLimitText } from "./boardText";
import { saveFailureNotice } from "./appUiState";

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

/** 当前画板越线提示：只提醒，不碰生成。 */
export function SizeNoticeBar({
  bytes,
  tier,
  canTidy,
  onTidy,
  onDismiss,
}: {
  bytes: number;
  tier: SizeTier;
  canTidy: boolean;
  onTidy(): void;
  onDismiss(): void;
}) {
  return (
    <div className={`bar ${tier === "alert" ? "bar-alert" : "bar-warn"} size-notice`} role="status" data-size-tier={tier}>
      <span>{sizeNoticeText(bytes)}</span>
      {/* 归档画板只读，不能整理（#90）。 */}
      {canTidy && (
        <button
          onClick={() => {
            onTidy();
          }}
        >
          整理
        </button>
      )}
      <button className="link" aria-label="关闭体量提示" onClick={onDismiss}>
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

/** 顶栏常驻的备份提示。 */
export const BackupHint = () => <div className="muted small topbar-backup-hint">{BACKUP_HINT_TEXT}</div>;
