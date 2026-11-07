// 画板列表：画板在服务端，关掉的标签页与另一个浏览器都从这里重新打开（桌面版靠启动参数 / 拖入文件）；也在这里删除画板。
// 列表由服务端拼好（#87）：每行带画板体量「约 X」，越过服务端配置的提醒线标黄 / 标红，只提醒。
// 同一对话框也是用量提醒里的「管理画板」（#88），那时按体量从大到小排。
import { useCallback, useEffect, useState } from "react";
import { BOARD_EXTENSION } from "../core/board";
import { bySizeDescending, sizeTier } from "../core/boardSize";
import { ipc } from "../shell/ipc";
import type { BoardListEntry, BoardListing } from "../shell/types";
import { errorText } from "../core/errors";
import { approxSizeText, MANAGE_BOARDS_TEXT } from "./boardText";

interface Props {
  /** 本页已打开的画板路径：列表里标注，不重复开。 */
  openPaths: string[];
  onOpen(path: string): void;
  /** 删除画板（移入回收区）；失败时 reject，错误留在确认框里。 */
  onDelete(path: string): Promise<void>;
  /** 删除前先导出画板包：沿用现有导出流程。 */
  onExport(path: string): void;
  onClose(): void;
  /** 「管理画板」（#88，从用量提醒进入）：标题换成管理画板，各组按体量从大到小排，帮用户决定先整理哪块。 */
  manage?: boolean;
}

const titleOf = (name: string) => name.slice(0, -BOARD_EXTENSION.length);

export function BoardListDialog({ openPaths, onOpen, onDelete, onExport, onClose, manage = false }: Props) {
  const [listing, setListing] = useState<BoardListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ entry: BoardListEntry; busy: boolean; error: string | null } | null>(null);
  const refresh = useCallback(() => {
    setError(null);
    ipc.listBoards().then(setListing, (e) => {
      setListing({ boards: [], slots: { used: 0, total: 0 }, size_lines: { warn: Infinity, alert: Infinity } });
      setError(errorText(e));
    });
  }, []);
  useEffect(refresh, [refresh]);

  const confirmDelete = async () => {
    if (!deleting || deleting.busy) return;
    setDeleting({ ...deleting, busy: true, error: null });
    try {
      await onDelete(deleting.entry.path);
      setDeleting(null);
    } catch (e) {
      setDeleting({ ...deleting, busy: false, error: errorText(e) });
    }
    refresh();
  };

  const row = (entry: BoardListEntry) => {
    const isOpen = openPaths.includes(entry.path);
    const tier = listing ? sizeTier(entry.bytes, listing.size_lines) : null;
    return (
      <li key={entry.path}>
        <button
          className="board-list-open"
          onClick={() => {
            onOpen(entry.path);
            onClose();
          }}
        >
          {titleOf(entry.name)}
        </button>
        {isOpen && <span className="muted">已打开</span>}
        <span className={`board-list-size${tier ? ` size-${tier}` : ""}`} data-size-tier={tier ?? "none"}>
          {entry.bytes === null ? "大小未知" : approxSizeText(entry.bytes)}
        </span>
        <button className="board-list-delete" aria-label={`删除「${titleOf(entry.name)}」`} onClick={() => setDeleting({ entry, busy: false, error: null })}>
          删除
        </button>
      </li>
    );
  };

  const boards = manage ? bySizeDescending(listing?.boards ?? []) : (listing?.boards ?? []);
  const editable = boards.filter((b) => !b.archived);
  const archived = boards.filter((b) => b.archived);
  const title = manage ? MANAGE_BOARDS_TEXT : "画板列表";
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="muted">{manage ? "按画板体量从大到小排列：先整理最大的几块。删除画板、整理掉不要的结果后，图片按清理规则释放空间。" : "画板保存在服务端；换浏览器后用同一把密钥也能看到同一份。"}</p>
        {error && <div className="bar bar-error">读取画板列表失败：{error}</div>}
        {listing === null ? (
          <div>正在加载…</div>
        ) : listing.boards.length === 0 ? (
          <div>还没有画板</div>
        ) : (
          <>
            {editable.length > 0 && <ul className="board-list">{editable.map(row)}</ul>}
            {archived.length > 0 && (
              <>
                <div className="board-list-group muted">已归档</div>
                <ul className="board-list board-list-archived">{archived.map(row)}</ul>
              </>
            )}
          </>
        )}
        <div className="modal-foot">
          <button onClick={refresh}>刷新</button>
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
      {deleting && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            if (!deleting.busy) setDeleting(null);
          }}
        >
          <div className="modal" role="dialog" aria-label="删除画板" onClick={(e) => e.stopPropagation()}>
            <h2>删除画板「{titleOf(deleting.entry.name)}」？</h2>
            <ul className="delete-notes">
              <li>画板里的生成结果仍保留在任务目录中，删除画板不会删除图片。</li>
              <li>不再被任何画板引用的结果之后可能被清理。</li>
              <li>误删可在 14 天内联系管理员恢复。</li>
            </ul>
            {deleting.error && <div className="bar bar-error">删除失败：{deleting.error}</div>}
            <div className="modal-foot">
              <button onClick={() => onExport(deleting.entry.path)} disabled={deleting.busy}>
                先导出画板包
              </button>
              <button className="danger" onClick={() => void confirmDelete()} disabled={deleting.busy}>
                {deleting.busy ? "正在删除…" : "删除"}
              </button>
              <button onClick={() => setDeleting(null)} disabled={deleting.busy}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
