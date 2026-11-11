// Alt + 拖复制的纯逻辑：开始时在原处叠一份副本、按 apply 后新出现的节点对齐副本 id、松手时与原节点对调。
// 这里只有判定与状态推演（不碰 React），useCanvasInteraction 只留 ref 与 apply 调用。
import type { Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { copySelection } from "../core/iterate";

/** 参与复制的原节点：id 与拖动前的位置（副本按这个顺序追加在节点末尾）。 */
export interface AltDragOriginal {
  id: string;
  pos: [number, number];
}

/** 拖动开始时要叠的那一份副本；null = 这次拖动没有 Alt 复制。 */
export interface AltDragStart {
  /** 交给 apply 的复制变更（副本叠在原处，与这次拖动合为一步）；null = 不复制。 */
  change: Extract<BoardChange, { kind: "duplicate" }> | null;
  /** 参与复制的原节点；不复制时为空数组。 */
  originals: AltDragOriginal[];
}

/** 待办的 Alt + 拖复制：pairs = [原节点, 副本]，starts = 原节点拖动前的位置（松手时对调用）。 */
export interface AltDrag {
  pairs: [string, string][];
  starts: [string, [number, number]][];
}

/** 按复制规则（copySelection）挑出原节点：非 Alt、没拖到节点、拖的只有结果节点时都为空。 */
function originalsOf(altKey: boolean, draggedIds: readonly string[], board: Board): AltDragOriginal[] {
  if (!altKey || !draggedIds.length) return [];
  return copySelection(board, [...draggedIds]).nodes.map((n) => ({ id: n.id, pos: n.pos }));
}

/**
 * 拖动开始：Alt + 拖到了可复制的节点时返回这次要叠的副本（含要交给 apply 的复制变更）。
 * 副本数 = 可复制的原节点数，drag.copies 让它与这次拖动合为一步。
 */
export function altDragStart(altKey: boolean, draggedIds: readonly string[], board: Board, dragId: number): AltDragStart {
  const originals = originalsOf(altKey, draggedIds, board);
  if (!originals.length) return { change: null, originals };
  return { change: { kind: "duplicate", ids: [...draggedIds], drag: { id: dragId, copies: originals.length } }, originals };
}

/**
 * apply 之后补齐副本 id：副本按复制顺序追加在节点末尾，所以「现在才出现的节点」与 originals 一一对应。
 * 没落账（没有撤销步）时返回 null = 这次拖动按普通拖动处理。
 */
export function altDragPending(before: Board, originals: readonly AltDragOriginal[], r: EditResult | null): AltDrag | null {
  if (!r?.step) return null;
  const had = new Set(before.nodes.map((n) => n.id));
  const copies = r.board.nodes.filter((n) => !had.has(n.id)).map((n) => n.id);
  return { pairs: originals.map((n, i): [string, string] => [n.id, copies[i]]), starts: originals.map((n): [string, [number, number]] => [n.id, n.pos]) };
}

/**
 * 松手：把 pairs / starts 交给既有的 settleDrag 变更（原节点回到起点、副本落在松手处，被拖走的是副本）。
 * pending = null 时返回 null，调用方不写画板。
 */
export function altDragSettle(pending: AltDrag | null, dragId: number): Extract<BoardChange, { kind: "settleDrag" }> | null {
  if (!pending) return null;
  return { kind: "settleDrag", drag: { id: dragId, copies: pending.pairs.length }, pairs: pending.pairs, starts: pending.starts };
}
