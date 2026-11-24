// 阶段：画板上一组命名区域，不是节点。这里只剩渲染与不变量要用的纯画板变换
// （收起的成员、阶段框尺寸、建议保留、删节点后的同步）；阶段自身的增删改随对应动作一起移除（#249）。
// 不变量：一个节点至多属于一个阶段；阶段只列画板上存在的节点；没有成员的阶段不存在。
import { isFinal, stagesOf, type Board, type BoardNode, type Stage } from "./board";

/** 以新的阶段列表替换；没有阶段时不留 stages 字段。 */
function withStages(board: Board, stages: Stage[]): Board {
  const { stages: _, ...rest } = board;
  return stages.length ? { ...rest, stages } : rest;
}

/** 阶段框在成员外留的边距（画布坐标）。 */
export const STAGE_PADDING = 24;

/** 收起的阶段里的节点：画布上不显示。只读查看默认展开，不修改画板内容。 */
export function collapsedMembers(board: Board, readOnly = false): ReadonlySet<string> {
  return new Set(readOnly ? [] : stagesOf(board).flatMap((s) => (s.collapsed ? s.nodes : [])));
}

export interface StageBox {
  stage: Stage;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 画板上存在的成员数。 */
  count: number;
}

/** 各阶段在画布上的框：包住全部成员并留边距。sizeOf = 节点的显示尺寸（还没测到为 undefined，退回存的尺寸）。 */
export function stageBoxes(board: Board, sizeOf: (id: string) => { width?: number; height?: number } | undefined, readOnly = false): StageBox[] {
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  return stagesOf(board).flatMap((stage) => {
    const members = stage.nodes.flatMap((id) => {
      const n = byId.get(id);
      return n && n.type !== "unknown" ? [n] : [];
    });
    if (!members.length) return [];
    const rects = members.map((n) => {
      const s = sizeOf(n.id);
      return [n.pos[0], n.pos[1], n.pos[0] + (s?.width ?? n.size[0]), n.pos[1] + (s?.height ?? n.size[1])];
    });
    const x = Math.min(...rects.map((r) => r[0])) - STAGE_PADDING;
    const y = Math.min(...rects.map((r) => r[1])) - STAGE_PADDING;
    const right = Math.max(...rects.map((r) => r[2])) + STAGE_PADDING;
    const bottom = Math.max(...rects.map((r) => r[3])) + STAGE_PADDING;
    return [{ stage: readOnly ? { ...stage, collapsed: false } : stage, x, y, width: right - x, height: bottom - y, count: members.length }];
  });
}

/** 从各阶段里拿走这些节点；空了的阶段删去。 */
const without = (stages: Stage[], ids: ReadonlySet<string>): Stage[] =>
  stages.flatMap((s) => {
    if (!s.nodes.some((id) => ids.has(id))) return [s];
    const nodes = s.nodes.filter((id) => !ids.has(id));
    return nodes.length ? [{ ...s, nodes }] : [];
  });

/** 后置不变量：阶段只列画板上存在的节点（删节点后同步），空了的阶段删去。 */
export function pruneStages(board: Board): Board {
  const stages = stagesOf(board);
  if (!stages.length) return board;
  const present = new Set(board.nodes.map((n) => n.id));
  const gone = new Set(stages.flatMap((s) => s.nodes.filter((id) => !present.has(id))));
  return gone.size ? withStages(board, without(stages, gone)) : board;
}

/**
 * 「建议保留」：每条结果列（结果节点 task_id 相同）里画板顺序上最新的那一张。
 * 只在整理模式里显示，不写进画板、不进撤销步。
 * 已定稿、或已有下游连线（被拿去当参考图）的不参与标记——也不回退到次新的一张。
 */
export function suggestKeep(board: Board): ReadonlySet<string> {
  const downstream = new Set(board.edges.map((e) => e.from[0]));
  // 画板顺序覆盖：同一列的后来者即最新的一张。
  const latest = new Map<string, BoardNode>();
  for (const n of board.nodes) if (n.type === "result") latest.set(n.task_id, n);
  return new Set([...latest.values()].flatMap((n) => (!isFinal(n) && !downstream.has(n.id) ? [n.id] : [])));
}
