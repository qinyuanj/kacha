// 画板体量（#87）：按服务端给的提醒线分档，以及当前画板越线提示该不该出现。
// 体量由服务端算（画板引用的全部任务目录的字节和）；这里只做档位判断，只提醒、不阻止生成。

/** 越线档位：warn 越过黄线，alert 越过红线。 */
export type SizeTier = "warn" | "alert";

/** 体量提醒线（字节），来自服务端配置。 */
export interface SizeLines {
  warn: number;
  alert: number;
}

const RANK: Record<SizeTier, number> = { warn: 1, alert: 2 };

/** 超过红线为 alert，超过黄线为 warn；未越线或体量未知为 null。 */
export function sizeTier(bytes: number | null, lines: SizeLines): SizeTier | null {
  if (bytes === null) return null;
  if (bytes > lines.alert) return "alert";
  if (bytes > lines.warn) return "warn";
  return null;
}

/**
 * 当前画板的越线提示：`notified` 是这块画板已提醒到（用户关过）的档位，记在 ui-state。
 * 返回此刻该显示的档位（null 不显示）与按当前体量校正后的已提醒档位：回落到某条线下，该线的记录随之清除，
 * 再次越线重新提醒。用户关闭提示时把 `notified` 记为当前档位。
 */
export function sizeNotice(tier: SizeTier | null, notified: SizeTier | undefined): { show: SizeTier | null; notified: SizeTier | undefined } {
  if (tier === null) return { show: null, notified: undefined };
  const kept = notified === undefined ? undefined : RANK[notified] > RANK[tier] ? tier : notified;
  const show = kept === undefined || RANK[tier] > RANK[kept] ? tier : null;
  return { show, notified: kept };
}
