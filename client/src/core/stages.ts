// 阶段与定稿（整理的基础）：阶段是画板上一组命名区域，不是节点；定稿是结果节点上的布尔属性。
// 这里只有纯的画板变换，撤销步描述与归并由 edit 按变更种类决定。无变化时返回原画板（同一引用）。
// 不变量：一个节点至多属于一个阶段；阶段只列画板上存在的节点；没有成员的阶段不存在。
import { isFinal, stagesOf, type Board, type BoardNode, type Stage } from "./board";

/** 以新的阶段列表替换；没有阶段时不留 stages 字段。 */
function withStages(board: Board, stages: Stage[]): Board {
  const { stages: _, ...rest } = board;
  return stages.length ? { ...rest, stages } : rest;
}

/** 阶段框在成员外留的边距（画布坐标）。 */
export const STAGE_PADDING = 24;

/** 收起的阶段里的节点：画布上不显示。 */
export function collapsedMembers(board: Board): ReadonlySet<string> {
  return new Set(stagesOf(board).flatMap((s) => (s.collapsed ? s.nodes : [])));
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
export function stageBoxes(board: Board, sizeOf: (id: string) => { width?: number; height?: number } | undefined): StageBox[] {
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
    return [{ stage, x, y, width: right - x, height: bottom - y, count: members.length }];
  });
}

/** 新建阶段的默认名：「阶段 N」，N 从已有阶段数 + 1 起，跳过重名。 */
export function nextStageName(board: Board): string {
  const names = new Set(stagesOf(board).map((s) => s.name));
  for (let i = stagesOf(board).length + 1; ; i++) if (!names.has(`阶段 ${i}`)) return `阶段 ${i}`;
}

/** 从各阶段里拿走这些节点；空了的阶段删去。 */
const without = (stages: Stage[], ids: ReadonlySet<string>): Stage[] =>
  stages.flatMap((s) => {
    if (!s.nodes.some((id) => ids.has(id))) return [s];
    const nodes = s.nodes.filter((id) => !ids.has(id));
    return nodes.length ? [{ ...s, nodes }] : [];
  });

/** 画板上存在、可以进阶段的节点（按给出的顺序、去重）。 */
function presentIds(board: Board, ids: readonly string[]): string[] {
  const present = new Set(board.nodes.filter((n) => n.type !== "unknown").map((n) => n.id));
  return [...new Set(ids)].filter((id) => present.has(id));
}

/** 建阶段：成员从原阶段带走。名字为空或没有可用节点时不变。 */
export function createStage(board: Board, id: string, name: string, ids: readonly string[]): Board {
  const nodes = presentIds(board, ids);
  const trimmed = name.trim();
  if (!trimmed || !nodes.length) return board;
  return withStages(board, [...without(stagesOf(board), new Set(nodes)), { id, name: trimmed, nodes, collapsed: false, extra: {} }]);
}

/** 改一个阶段；fn 返回同一对象即不变。 */
function mapStage(board: Board, stageId: string, fn: (s: Stage) => Stage | null): Board {
  const stages = stagesOf(board);
  const i = stages.findIndex((s) => s.id === stageId);
  if (i < 0) return board;
  const next = fn(stages[i]);
  if (next === stages[i]) return board;
  return withStages(board, next ? stages.map((s, k) => (k === i ? next : s)) : stages.filter((_, k) => k !== i));
}

export function renameStage(board: Board, stageId: string, name: string): Board {
  const trimmed = name.trim();
  return mapStage(board, stageId, (s) => (!trimmed || s.name === trimmed ? s : { ...s, name: trimmed }));
}

export const setStageCollapsed = (board: Board, stageId: string, collapsed: boolean): Board =>
  mapStage(board, stageId, (s) => (s.collapsed === collapsed ? s : { ...s, collapsed }));

/** 删阶段：只删区域，节点不动。 */
export const deleteStage = (board: Board, stageId: string): Board => mapStage(board, stageId, () => null);

/** 加入阶段：新成员追加在末尾，并从原阶段带走。 */
export function addToStage(board: Board, stageId: string, ids: readonly string[]): Board {
  const stages = stagesOf(board);
  const target = stages.find((s) => s.id === stageId);
  if (!target) return board;
  const fresh = presentIds(board, ids).filter((id) => !target.nodes.includes(id));
  if (!fresh.length) return board;
  const moving = new Set(fresh);
  return withStages(board, stages.flatMap((s) => (s === target ? [{ ...s, nodes: [...s.nodes, ...fresh] }] : without([s], moving))));
}

/** 移出阶段：节点从所在阶段拿走（仍留在画板上）。 */
export function removeFromStage(board: Board, ids: readonly string[]): Board {
  const leaving = new Set(ids);
  const stages = stagesOf(board);
  return stages.some((s) => s.nodes.some((id) => leaving.has(id))) ? withStages(board, without(stages, leaving)) : board;
}

/** 后置不变量：阶段只列画板上存在的节点（删节点后同步），空了的阶段删去。 */
export function pruneStages(board: Board): Board {
  const stages = stagesOf(board);
  if (!stages.length) return board;
  const present = new Set(board.nodes.map((n) => n.id));
  const gone = new Set(stages.flatMap((s) => s.nodes.filter((id) => !present.has(id))));
  return gone.size ? withStages(board, without(stages, gone)) : board;
}

/** 选区的定稿开关：选区里的结果有未定稿的就是标记，否则是取消；没有结果为 null。菜单文案与执行共用。 */
export function finalToggle(board: Board, ids: Iterable<string>): { nodes: string[]; final: boolean } | null {
  const wanted = new Set(ids);
  const results = board.nodes.filter((n) => n.type === "result" && wanted.has(n.id));
  if (!results.length) return null;
  return { nodes: results.map((n) => n.id), final: results.some((n) => !isFinal(n)) };
}

/** 选区里是否有节点在某个阶段里。 */
export const anyStaged = (board: Board, ids: Iterable<string>): boolean => {
  const wanted = new Set(ids);
  return stagesOf(board).some((s) => s.nodes.some((id) => wanted.has(id)));
};

/** 标记 / 取消定稿：只作用于结果节点。 */
export function setFinal(board: Board, ids: readonly string[], final: boolean): Board {
  const wanted = new Set(ids);
  let changed = false;
  const nodes = board.nodes.map((n): BoardNode => {
    if (n.type !== "result" || !wanted.has(n.id) || (n.final === true) === final) return n;
    changed = true;
    if (final) return { ...n, final: true };
    const { final: _, ...rest } = n;
    return rest;
  });
  return changed ? { ...board, nodes } : board;
}
