// 按任务节点聚合各份（运行器快照与重开后的已存状态共用）；只依赖运行器的类型，不形成运行时环。
import type { NodeRunState, StatusCounts, TaskCopy } from "./runner";

/** 属于某个任务节点的一份，按节点聚合前的形状。 */
export interface NodeCopyEntry {
  taskNodeId: string;
  /** 该份所属提交为这个节点展开的份数。 */
  total: number;
  copy: TaskCopy;
}

/** 按任务节点聚合各份：明细按给出的先后，计数随之累加；运行器快照与重开后的已存状态共用。 */
export function groupCopies(entries: Iterable<NodeCopyEntry>): Map<string, NodeRunState> {
  const nodes = new Map<string, { copies: TaskCopy[]; counts: StatusCounts; total: number }>();
  for (const { taskNodeId, total, copy } of entries) {
    let n = nodes.get(taskNodeId);
    if (!n) nodes.set(taskNodeId, (n = { copies: [], counts: {}, total }));
    n.copies.push(copy);
    n.counts[copy.status.kind] = (n.counts[copy.status.kind] ?? 0) + 1;
  }
  return nodes;
}
