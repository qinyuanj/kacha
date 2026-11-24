// 画板列表对话框的可见判定（#137）：从 ui/BoardListDialog.tsx 拆出的纯逻辑，便于单测。
import { BOARD_EXTENSION } from "../core/board";
import { bySizeDescending, sizeTier, type SizeTier } from "../core/boardSize";
import type { BoardListEntry, BoardListing } from "../shell/types";

/** 画板名（去掉扩展名）：列表里显示的是标题，不是文件名。 */
const titleOf = (name: string) => name.slice(0, -BOARD_EXTENSION.length);

/** 一行画板在列表里的样子。 */
interface BoardRow {
  entry: BoardListEntry;
  /** 标题（去扩展名）。 */
  title: string;
  /** 本页已经打开着。 */
  isOpen: boolean;
  /** 体量档位（高于分档阈值时才有）。 */
  tier: SizeTier | null;
  /** 归档画板。 */
  archived: boolean;
}

/** 列表按体量分两组：可编辑的与归档的。 */
interface BoardGroups {
  editable: BoardListEntry[];
  archived: BoardListEntry[];
}

/** 「管理画板」按体量从大到小排，普通列表照本机存储给的顺序。 */
export function boardGroups(listing: BoardListing | null, manage: boolean): BoardGroups {
  const boards = listing?.boards ?? [];
  const sorted = manage ? bySizeDescending(boards) : boards;
  return { editable: sorted.filter((b) => !b.archived), archived: sorted.filter((b) => b.archived) };
}

/** 一行画板的样子：标题、是否已打开、体量档位。 */
export function boardRow(entry: BoardListEntry, openPaths: readonly string[], listing: BoardListing | null): BoardRow {
  return {
    entry,
    title: titleOf(entry.name),
    isOpen: openPaths.includes(entry.path),
    tier: listing ? sizeTier(entry.bytes, listing.size_lines) : null,
    archived: entry.archived,
  };
}

/** 画板位已满：不能再新建（老用户超出的情况只是提醒，不挡编辑）。 */
export function slotsFull(listing: BoardListing | null): boolean {
  if (!listing) return false;
  return listing.slots.used >= listing.slots.total;
}

/** 画板位超出：列表顶部提醒先备份并删除不再需要的画板。 */
export function overSlots(listing: BoardListing | null): boolean {
  if (!listing) return false;
  return listing.slots.used > listing.slots.total;
}

/** 列表的标题：普通列表与「管理画板」两种。 */
export function listTitle(manage: boolean, manageTitle: string): string {
  return manage ? manageTitle : "画板列表";
}

/** 列表的说明文字：两种入口各一句。 */
export function listDescription(manage: boolean): string {
  return manage
    ? "按画板体量从大到小排列。删除画板不会删除任务目录中的图片；请先备份数据根。"
    : "画板保存在这台电脑的数据根中；更换 API 密钥不会改变已有画板。";
}
