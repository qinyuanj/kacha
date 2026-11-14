// 用量区块的可见判定（#137）：从 ui/UsageSection.tsx 拆出的纯逻辑，便于单测。
import { formatBytes } from "./boardText";
import type { Usage, UsageCandidate } from "../shell/types";

/** 未引用任务目录的合计字节。 */
export function unreferencedBytes(dirs: readonly UsageCandidate[]): number {
  return dirs.reduce((n, d) => n + d.bytes, 0);
}

/** 未引用任务目录的一句话摘要：没有时说没有，有时说个数与体量。 */
export function unreferencedSummary(dirs: readonly UsageCandidate[]): string {
  if (dirs.length === 0) return "没有未引用任务目录";
  return `${dirs.length} 个未引用任务目录，共 ${formatBytes(unreferencedBytes(dirs))}`;
}

/** 清理完成后的说明：移走了几个，有几个不符合条件没动。 */
export function cleanupNote(result: { moved: UsageCandidate[]; skipped: string[] }): string {
  const moved = `已把 ${result.moved.length} 个任务目录移入回收区`;
  return result.skipped.length ? `${moved}；${result.skipped.length} 个已不符合条件，未动` : moved;
}

/** 清理按钮能不能点：没有未引用目录、有画板读不懂、或正在清理时都不行。 */
export function canClean(usage: Usage | null, busy: boolean): boolean {
  if (!usage) return false;
  if (busy) return false;
  if (usage.unreadable_board) return false;
  return (usage.unreferenced?.length ?? 0) > 0;
}

/** 画板读不懂时的提示。 */
export function unreadableNotice(board: string): string {
  return `画板读不懂（${board}），为避免误删暂不清理；仍被画板引用的结果不会按时间清理。`;
}

/** 用量分项的说明行。 */
export function usageBreakdown(usage: Usage): string {
  return `画板 ${formatBytes(usage.boards_bytes)}；设置与缓存 ${formatBytes(usage.meta_bytes)}；最后访问 ${new Date(usage.last_access * 1000).toLocaleString()}`;
}

/** 按日期的用量说明。 */
export function usageByDate(usage: Usage): string {
  return usage.by_date.length === 0 ? "还没有任务目录" : usage.by_date.map((d) => `${d.date}：${formatBytes(d.bytes)}`).join("；");
}
