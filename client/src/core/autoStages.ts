// 自动划分阶段（#143）：按一次生成尝试把还没进阶段的节点分成组，交给 edit 建阶段。
// 一次尝试 = 一个生成任务 + 它的结果列（系统连线指向的结果，结果只按 task_id 归属）+ 直接喂给它的提示词与参考图。
// 这里只读画板、不改画板：成员只从还没进任何阶段的节点里取，任务被删而结果还在时同一 task_id 的结果列照自成组。
// 成不成阶段只看成员数（少于 2 个不成组），组的先后按组内第一个成员在画板上的先后。
//
// 结果列只能经系统连线归到任务：结果节点上的 `task_id` 是服务端的提交编号（形如 20260916T091500Z-aea3c5c6），
// 不是任务节点 id（任务节点 id 在 layout.NewResult.taskId 里，画板写盘时不进结果节点），所以「这个任务的结果」=
// 任务指向结果的系统连线，列内成员按结果节点上相同的 `task_id` 取全。**别改成「task_id 等于任务节点 id」，那认不到任何结果。**
// 任务节点已被删（或已进阶段）而结果还散着时，同 `task_id` 的一组结果自成一列、自己成组——归属规则不变，成不成阶段只看成员数。
import { stagesOf, type Board } from "./board";

/** 能直接喂给生成任务的节点类型：提示词与参考图（结果要经系统连线归属，不在这里认领）。 */
const FEEDERS = new Set(["prompt", "reference"]);

const stagedIds = (board: Board): ReadonlySet<string> => new Set(stagesOf(board).flatMap((s) => s.nodes));

const boardOrder = (board: Board): Map<string, number> => new Map(board.nodes.map((n, i) => [n.id, i]));

/** 还是散着的节点：本版本认识的、且不在任何阶段里（按画板顺序）。 */
const looseIds = (board: Board, staged: ReadonlySet<string>): string[] =>
  board.nodes.filter((n) => n.type !== "unknown" && !staged.has(n.id)).map((n) => n.id);

/** 结果节点 id → 它的提交编号。 */
const columnsByResult = (board: Board): Map<string, string> =>
  new Map(board.nodes.flatMap((n) => (n.type === "result" ? [[n.id, n.task_id] as const] : [])));

/** 任务节点 id → 它经系统连线指向的结果列（提交编号）。 */
function columnsByTask(board: Board, columns: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of board.edges) {
    const column = e.system ? columns.get(e.to[0]) : undefined;
    if (column !== undefined) out.set(e.from[0], [...(out.get(e.from[0]) ?? []), column]);
  }
  return out;
}

/** 任务节点 id → 直接连线喂给它的提示词与参考图。 */
function feedersByTask(board: Board): Map<string, string[]> {
  const node = new Map(board.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of board.edges) {
    const source = node.get(e.from[0]);
    if (!e.system && source && FEEDERS.has(source.type)) out.set(e.to[0], [...(out.get(e.to[0]) ?? []), e.from[0]]);
  }
  return out;
}

/** 认领一组候选成员：只取散着且还没被别组认领的，按画板上的先后。一次划分里每张节点只进一个组。 */
function claimant(order: Map<string, number>, staged: ReadonlySet<string>): (ids: Iterable<string>) => string[] {
  const claimed = new Set<string>();
  return (ids) => {
    const fresh = [...new Set(ids)].filter((id) => order.has(id) && !staged.has(id) && !claimed.has(id));
    for (const id of fresh) claimed.add(id);
    return fresh.sort((a, b) => order.get(a)! - order.get(b)!);
  };
}

/** 某一列（或几列）里散着的结果节点，按画板顺序。 */
function columnMembers(loose: readonly string[], columns: Map<string, string>, wanted: Iterable<string>): string[] {
  const columnSet = new Set(wanted);
  return loose.filter((id) => columnSet.has(columns.get(id) ?? ""));
}

/** 每个生成任务带它的结果列与输入，凑成一组。 */
function taskGroups(board: Board, take: (ids: Iterable<string>) => string[], members: (columns: Iterable<string>) => string[],
  byTask: Map<string, string[]>, feeders: Map<string, string[]>): string[][] {
  return board.nodes
    .filter((n) => n.type === "task")
    .map((n) => take([n.id, ...members(byTask.get(n.id) ?? []), ...(feeders.get(n.id) ?? [])]))
    .filter((group) => group.length > 0);
}

/** 任务节点已不在画板上、结果还散着：同一列的结果自己成组。 */
function orphanGroups(loose: readonly string[], columns: Map<string, string>, take: (ids: Iterable<string>) => string[], members: (columns: Iterable<string>) => string[]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of loose) {
    const column = columns.get(id);
    if (column !== undefined && !seen.has(column)) {
      seen.add(column);
      out.push(take(members([column])));
    }
  }
  return out;
}

/** 凑得成阶段的组（成员少于 2 个的不成组），按组内第一个成员在画板上的先后。 */
const ranked = (groups: string[][], order: Map<string, number>): string[][] =>
  groups.filter((group) => group.length >= 2).sort((a, b) => order.get(a[0])! - order.get(b[0])!);

/** 一次生成尝试划出来的成员组（节点 id，按画板上的先后）。同一份画板算出同一份结果。 */
export function autoStageGroups(board: Board): string[][] {
  const staged = stagedIds(board);
  const order = boardOrder(board);
  const loose = looseIds(board, staged);
  const columns = columnsByResult(board);
  const take = claimant(order, staged);
  const members = (wanted: Iterable<string>) => columnMembers(loose, columns, wanted);
  const groups = [
    ...taskGroups(board, take, members, columnsByTask(board, columns), feedersByTask(board)),
    ...orphanGroups(loose, columns, take, members),
  ];
  return ranked(groups, order);
}
