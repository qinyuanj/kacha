// 用量上限提醒的分档（#137）：从 useUsageLimit 拆出的纯逻辑，便于单测。
import type { SizeTier } from "../core/boardSize";
import type { Usage } from "../shell/types";

export interface UsageLimitNotice {
  level: SizeTier;
  total: number;
  limit: number;
}

/** 本机存储算好的提醒档位：上限留空或没到线时不提醒。 */
export function usageNoticeOf(usage: Usage): UsageLimitNotice | null {
  if (!usage.limit_level || usage.limit_bytes === null) return null;
  return { level: usage.limit_level, total: usage.total_bytes, limit: usage.limit_bytes };
}
