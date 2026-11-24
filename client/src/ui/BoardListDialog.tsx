// 画板列表：重新打开或删除保存在这台电脑上的画板。
// 列表由本机存储拼好（#87）：每行带画板体量「约 X」，高于本机存储配置的阈值标黄 / 标红，只描述大小。
// 同一对话框也是用量提醒里的「管理画板」（#88），那时按体量从大到小排。
// 可见判定在 ui/boardListView.ts（#137），这里只留接线与 DOM 摆放。
import { useCallback, useEffect, useState } from "react";
import type { BoardListEntry, BoardListing } from "../shell/types";
import { errorText } from "../core/errors";
import { useShell } from "./shell";
import { ARCHIVE_TEXT, MANAGE_BOARDS_TEXT, OVER_SLOTS_TEXT, slotsUsageText } from "./boardText";
import { boardGroups, boardRow, listDescription, listTitle, overSlots, slotsFull } from "./boardListView";
import { BoardRow, type RowActions } from "./boardListRow";
import { runArchivedAction, runConfirm, type PendingAction } from "./boardListActions";

interface Props {
  /** 本页已打开的画板路径：列表里标注，不重复开。 */
  openPaths: string[];
  onOpen(path: string): void;
  /** 删除画板（移入回收区）；失败时 reject，错误留在确认框里。 */
  onDelete(path: string): Promise<void>;
  /** 删除前先导出画板包：沿用现有导出流程。 */
  onExport(path: string): void;
  onClose(): void;
  /** 归档（#90，确认后）；失败时 reject，错误留在确认框里。 */
  onArchive(path: string): Promise<void>;
  /** 取消归档 / 复制为新画板：画板位满时 resolve 统一文案，成功为 null。 */
  onUnarchive(path: string): Promise<string | null>;
  onCopy(path: string): Promise<string | null>;
  /** 「管理画板」（#88，从用量提醒进入）：标题换成管理画板，各组按体量从大到小排，帮用户决定先整理哪块。 */
  manage?: boolean;
}

/** 画板位用量那一行。 */
function SlotsRow({ listing, error }: { listing: BoardListing | null; error: string | null }) {
  if (!listing || error) return null;
  return (
    <div className="board-list-slots" data-slots-full={slotsFull(listing)}>
      <span className={slotsFull(listing) ? "board-list-slots-full" : "muted"}>{slotsUsageText(listing.slots)}</span>
      {/* 超出画板位的老用户（#89）：现有画板照常编辑，只是不能新建。 */}
      {overSlots(listing) && <span className="board-list-over" role="status">{OVER_SLOTS_TEXT}</span>}
    </div>
  );
}

/** 一组画板（普通或归档）。 */
function BoardGroup({
  entries,
  listing,
  openPaths,
  onOpen,
  onClose,
  actions,
}: {
  entries: BoardListEntry[];
  listing: BoardListing | null;
  openPaths: string[];
  onOpen(path: string): void;
  onClose(): void;
  actions: RowActions;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="board-list">
      {entries.map((entry) => (
        <BoardRow key={entry.path} entry={entry} openPaths={openPaths} listing={listing} onOpen={onOpen} onClose={onClose} actions={actions} />
      ))}
    </ul>
  );
}

/** 列表主体：画板位用量、分组与每一行。 */
function BoardListBody({
  listing,
  error,
  manage,
  openPaths,
  onOpen,
  onClose,
  actions,
}: {
  listing: BoardListing | null;
  error: string | null;
  manage: boolean;
  openPaths: string[];
  onOpen(path: string): void;
  onClose(): void;
  actions: RowActions;
}) {
  const groups = boardGroups(listing, manage);
  return (
    <>
      <SlotsRow listing={listing} error={error} />
      {listing === null ? (
        <div>正在加载…</div>
      ) : listing.boards.length === 0 ? (
        <div>还没有画板</div>
      ) : (
        <>
          <BoardGroup entries={groups.editable} listing={listing} openPaths={openPaths} onOpen={onOpen} onClose={onClose} actions={actions} />
          {groups.archived.length > 0 && (
            <>
              <div className="board-list-group muted">{ARCHIVE_TEXT.group}</div>
              <ul className="board-list board-list-archived">
                {groups.archived.map((entry) => (
                  <BoardRow key={entry.path} entry={entry} openPaths={openPaths} listing={listing} onOpen={onOpen} onClose={onClose} actions={actions} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

/** 删除画板的确认框。 */
function DeleteConfirm({
  title,
  busy,
  error,
  onExport,
  onConfirm,
  onCancel,
  canExport,
}: {
  title: string;
  busy: boolean;
  error: string | null;
  canExport: boolean;
  onExport(): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-label="删除画板" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>删除画板「{title}」？</h2>
          <button className="icon-button" aria-label="关闭" onClick={onCancel} disabled={busy}>
            ✕
          </button>
        </div>
        <ul className="delete-notes">
          <li>画板里的生成结果仍保留在任务目录中，删除画板不会删除图片。</li>
          <li>删除后不能在客户端撤销，请先备份数据根。</li>
        </ul>
        {error && <div className="bar bar-error">删除失败：{error}</div>}
        <div className="modal-foot">
          <button onClick={onExport} disabled={busy || !canExport}>
            先导出画板包
          </button>
          <button className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "正在删除…" : "删除"}
          </button>
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 归档画板的确认框。 */
function ArchiveConfirm({
  title,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-label="归档画板" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>归档画板「{title}」？</h2>
          <button className="icon-button" aria-label="关闭" onClick={onCancel} disabled={busy}>
            ✕
          </button>
        </div>
        <p className="archive-confirm-text">{ARCHIVE_TEXT.confirm}</p>
        {error && <div className="bar bar-error">归档失败：{error}</div>}
        <div className="modal-foot">
          <button className="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "正在归档…" : ARCHIVE_TEXT.action}
          </button>
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 画板列表的读取与刷新。 */
function useBoardListing() {
  const port = useShell();
  const [listing, setListing] = useState<BoardListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setError(null);
    port.board.list().then(setListing, (e) => {
      setListing({ boards: [], slots: { used: 0, total: 0 }, size_lines: { warn: Infinity, alert: Infinity } });
      setError(errorText(e));
    });
  }, []);
  useEffect(refresh, [refresh]);
  return { listing, error, refresh };
}

/** 画板列表的确认框：删除与归档。 */
function useBoardConfirm(refresh: () => void) {
  const [deleting, setDeleting] = useState<PendingAction | null>(null);
  const [archiving, setArchiving] = useState<PendingAction | null>(null);
  const confirmDelete = async (onDelete: (path: string) => Promise<void>) => {
    if (!deleting || deleting.busy) return;
    setDeleting({ ...deleting, busy: true, error: null });
    const result = await runConfirm(deleting, (entry) => onDelete(entry.path));
    if (result.ok) setDeleting(null);
    else setDeleting({ ...deleting, busy: false, error: result.error });
    refresh();
  };
  const confirmArchive = async (onArchive: (path: string) => Promise<void>) => {
    if (!archiving || archiving.busy) return;
    setArchiving({ ...archiving, busy: true, error: null });
    const result = await runConfirm(archiving, (entry) => onArchive(entry.path));
    if (result.ok) setArchiving(null);
    else setArchiving({ ...archiving, busy: false, error: result.error });
    refresh();
  };
  return { deleting, setDeleting, archiving, setArchiving, confirmDelete, confirmArchive };
}

export function BoardListDialog({ openPaths, onOpen, onDelete, onExport, onClose, onArchive, onUnarchive, onCopy, manage = false }: Props) {
  const { listing, error, refresh } = useBoardListing();
  const port = useShell();
  const confirm = useBoardConfirm(refresh);
  const { deleting, setDeleting, archiving, setArchiving } = confirm;
  /** 取消归档 / 复制为新画板被拒（画板位满）或失败时的说明。 */
  const [actionError, setActionError] = useState<string | null>(null);

  const runArchived = async (action: (path: string) => Promise<string | null>, entry: BoardListEntry) => {
    setActionError(null);
    const refusal = await runArchivedAction(action, entry);
    if (refusal) setActionError(refusal);
    refresh();
  };

  const actions: RowActions = {
    archive: (entry) => setArchiving({ entry, busy: false, error: null }),
    unarchive: (entry) => void runArchived(onUnarchive, entry),
    copy: (entry) => void runArchived(onCopy, entry),
    remove: (entry) => setDeleting({ entry, busy: false, error: null }),
  };
  const title = listTitle(manage, MANAGE_BOARDS_TEXT);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted">{listDescription(manage)}</p>
        {error && <div className="bar bar-error">读取画板列表失败：{error}</div>}
        {actionError && (
          <div className="bar bar-error" role="alert">
            <span>{actionError}</span>
            <button className="link" onClick={() => setActionError(null)}>知道了</button>
          </div>
        )}
        <BoardListBody listing={listing} error={error} manage={manage} openPaths={openPaths} onOpen={onOpen} onClose={onClose} actions={actions} />
        <div className="modal-foot">
          <button onClick={refresh}>刷新</button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
      {deleting && (
        <DeleteConfirm
          canExport={port.features.packExport}
          title={boardRow(deleting.entry, openPaths, listing).title}
          busy={deleting.busy}
          error={deleting.error}
          onExport={() => onExport(deleting.entry.path)}
          onConfirm={() => void confirm.confirmDelete(onDelete)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {archiving && (
        <ArchiveConfirm
          title={boardRow(archiving.entry, openPaths, listing).title}
          busy={archiving.busy}
          error={archiving.error}
          onConfirm={() => void confirm.confirmArchive(onArchive)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
