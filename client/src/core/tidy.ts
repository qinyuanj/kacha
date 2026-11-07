// 整理模式的体量（#92）：服务端按任务目录量出画板（每个节点引用哪些任务目录、每个任务目录多少字节），
// 这里只做集合运算——阶段体量、「收掉未定稿」预计减少多少。口径与画板体量一致：同一任务目录在一块画板里只算一次。

/** 服务端对一块画板的度量（POST /api/boards/measure）。 */
export interface BoardMeasure {
  /** 节点 id → 引用的任务目录；不引用任务目录的节点不列。 */
  nodes: Record<string, string[]>;
  /** 画板引用的每个任务目录 → 字节数。 */
  dirs: Record<string, number>;
}

const sumDirs = (measure: BoardMeasure, dirs: Iterable<string>) => [...new Set(dirs)].reduce((s, d) => s + (measure.dirs[d] ?? 0), 0);

const dirsOf = (measure: BoardMeasure, ids: Iterable<string>) => [...ids].flatMap((id) => measure.nodes[id] ?? []);

/** 画板体量：引用的各任务目录字节之和。 */
export const boardBytes = (measure: BoardMeasure): number => sumDirs(measure, Object.keys(measure.dirs));

/** 一组节点（如一个阶段的成员）的体量：它们引用的任务目录各算一次。 */
export const nodesBytes = (measure: BoardMeasure, ids: Iterable<string>): number => sumDirs(measure, dirsOf(measure, ids));

/** 删去这些节点后画板预计减少的体量：只算不再被其余节点引用的任务目录。 */
export function pruneSavings(measure: BoardMeasure, removed: readonly string[]): number {
  const gone = new Set(removed);
  const kept = new Set(dirsOf(measure, Object.keys(measure.nodes).filter((id) => !gone.has(id))));
  return sumDirs(measure, dirsOf(measure, gone).filter((d) => !kept.has(d)));
}
