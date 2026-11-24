// 「移出为新画板」（#93）已在 1.7.0 移除（#251）：拆分出新画板、节点 id 重排、上游图片转参考图并记来源画板、
// 采集图片身份的那半都删掉了。这里只剩原画板这一侧：删去移出的阶段节点，唯一调用方是画板变更 moveOutStage。
// 界面已经不再产生这个变更，收口留给 #255 的死代码清理。
import { stagesOf, type Board } from "./board";
import { removeNodes } from "./graph";

/** 移出的节点严格限于阶段成员。按画板顺序；阶段不存在为 null。 */
function movedIds(board: Board, stageId: string): string[] | null {
  const stage = stagesOf(board).find((s) => s.id === stageId);
  return stage ? board.nodes.filter((n) => stage.nodes.includes(n.id)).map((n) => n.id) : null;
}

/** 原画板移出阶段：阶段外的结果仍保留，只断开跨阶段的系统连线，避免普通删除任务的级联规则带走它们。 */
export function removeMovedStage(board: Board, stageId: string): Board {
  const ids = movedIds(board, stageId);
  if (!ids?.length) return board;
  const moved = new Set(ids);
  const edges = board.edges.filter((e) => !(e.system && moved.has(e.from[0]) && !moved.has(e.to[0])));
  return removeNodes({ ...board, edges }, ids).board;
}
