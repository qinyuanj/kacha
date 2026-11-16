// 自动划分阶段（#143）：按一次生成尝试把还没进阶段的节点分成组，交给 edit 建阶段。
// 一次尝试 = 一个生成任务 + 它的结果列（系统连线指向的结果，结果只按 task_id 归属）+ 直接喂给它的提示词与参考图。
// 这里只读画板、不改画板：成员只从还没进任何阶段的节点里取，任务被删而结果还在时同一 task_id 的结果列照自成组。
// 成不成阶段只看成员数（少于 2 个不成组），组的先后按组内第一个成员在画板上的先后。
import { stagesOf, type Board } from "./board";

/** 一次生成尝试划出来的成员组（节点 id，按画板上的先后）。 */
export function autoStageGroups(board: Board): string[][] {
  const staged = new Set(stagesOf(board).flatMap((s) => s.nodes));
  const order = new Map(board.nodes.map((n, i) => [n.id, i]));
  const node = new Map(board.nodes.map((n) => [n.id, n]));
  /** 还是散着的节点：认识、且不在任何阶段里。 */
  const loose = board.nodes.filter((n) => n.type !== "unknown" && !staged.has(n.id)).map((n) => n.id);

  // 结果的归属：结果节点上的 task_id 是提交编号；任务节点的结果列 = 它指向结果的系统连线，外加同 task_id 的结果。
  const columnOf = new Map<string, string>();
  for (const n of board.nodes) if (n.type === "result") columnOf.set(n.id, n.task_id);
  const columnsOf = new Map<string, Set<string>>();
  for (const e of board.edges) {
    const column = columnOf.get(e.to[0]);
    if (!e.system || column === undefined) continue;
    const columns = columnsOf.get(e.from[0]) ?? new Set<string>();
    columns.add(column);
    columnsOf.set(e.from[0], columns);
  }
  // 直接连线喂给任务的提示词与参考图（结果按结果列归属，不在这里认领）。
  const sourcesOf = new Map<string, string[]>();
  for (const e of board.edges) {
    const source = node.get(e.from[0]);
    if (e.system || (source?.type !== "prompt" && source?.type !== "reference")) continue;
    sourcesOf.set(e.to[0], [...(sourcesOf.get(e.to[0]) ?? []), e.from[0]]);
  }

  const claimed = new Set<string>();
  /** 认领一组候选成员：只取散着且还没被别组认领的，按画板上的先后。 */
  const take = (ids: Iterable<string>): string[] => {
    const fresh = [...new Set(ids)].filter((id) => order.has(id) && !staged.has(id) && !claimed.has(id));
    fresh.forEach((id) => claimed.add(id));
    return fresh.sort((a, b) => order.get(a)! - order.get(b)!);
  };
  const columnMembers = (columns: Iterable<string>) => {
    const wanted = new Set(columns);
    return loose.filter((id) => {
      const column = columnOf.get(id);
      return column !== undefined && wanted.has(column);
    });
  };

  const groups: string[][] = [];
  for (const n of board.nodes) {
    if (n.type !== "task" || claimed.has(n.id)) continue;
    const columns = columnsOf.get(n.id);
    const group = take([n.id, ...(columns ? columnMembers(columns) : []), ...(sourcesOf.get(n.id) ?? [])]);
    if (group.length) groups.push(group);
  }
  // 任务节点已被删（或已进阶段）、结果还散着：同一 task_id 的结果列自己成组。
  for (const id of loose) {
    const column = columnOf.get(id);
    if (claimed.has(id) || column === undefined) continue;
    const group = take(columnMembers([column]));
    if (group.length) groups.push(group);
  }
  return groups.filter((group) => group.length >= 2).sort((a, b) => order.get(a[0])! - order.get(b[0])!);
}
