// 画板列表的一行（#137）：从 ui/BoardListDialog.tsx 拆出的子组件，让对话框本体只留接线。
import type { BoardListEntry, BoardListing } from "../shell/types";
import { approxSizeText, ARCHIVE_TEXT } from "./boardText";
import { boardRow } from "./boardListView";

/** 一行画板的动作：归档、取消归档、复制为新画板、删除。 */
export interface RowActions {
  archive(entry: BoardListEntry): void;
  unarchive(entry: BoardListEntry): void;
  copy(entry: BoardListEntry): void;
  remove(entry: BoardListEntry): void;
}

/** 一行画板：标题、已打开标记、体量与动作。 */
export function BoardRow({ entry, openPaths, listing, onOpen, onClose, actions }: { entry: BoardListEntry; openPaths: string[]; listing: BoardListing | null; onOpen(path: string): void; onClose(): void; actions: RowActions }) {
  const row = boardRow(entry, openPaths, listing);
  return (
    <li key={entry.path}>
      <button
        className="board-list-open"
        onClick={() => {
          onOpen(entry.path);
          onClose();
        }}
      >
        {row.title}
      </button>
      {row.isOpen && <span className="muted">已打开</span>}
      <span className={`board-list-size${row.tier ? ` size-${row.tier}` : ""}`} data-size-tier={row.tier ?? "none"}>
        {entry.bytes === null ? "大小未知" : approxSizeText(entry.bytes)}
      </span>
      {row.archived ? (
        <>
          <button className="board-list-action" onClick={() => actions.unarchive(entry)}>
            {ARCHIVE_TEXT.unarchive}
          </button>
          <button className="board-list-action" onClick={() => actions.copy(entry)}>
            {ARCHIVE_TEXT.copy}
          </button>
        </>
      ) : (
        <button className="board-list-action" aria-label={`${ARCHIVE_TEXT.action}「${row.title}」`} onClick={() => actions.archive(entry)}>
          {ARCHIVE_TEXT.action}
        </button>
      )}
      <button className="board-list-delete" aria-label={`删除「${row.title}」`} onClick={() => actions.remove(entry)}>
        删除
      </button>
    </li>
  );
}

