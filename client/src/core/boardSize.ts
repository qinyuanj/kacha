// 画板体量（#87）：按本机存储给的两条阈值给画板分档（「管理画板」里标出较大的那几块）。
// 体量由本机存储算（画板引用的全部任务目录的字节和）；这里只做档位判断。

/** 体量档位：warn 高于黄线，alert 高于红线；只用于画板列表显示，不提供整理动作。 */
export type SizeTier = "warn" | "alert";

/** 画板列表的体量分档阈值（字节），来自本机存储配置。 */
export interface SizeLines {
  warn: number;
  alert: number;
}

/** 高于红线为 alert，高于黄线为 warn；未达到阈值或体量未知为 null。 */
export function sizeTier(bytes: number | null, lines: SizeLines): SizeTier | null {
  if (bytes === null) return null;
  if (bytes > lines.alert) return "alert";
  if (bytes > lines.warn) return "warn";
  return null;
}

/** 「管理画板」（#88）的顺序：体量从大到小，体量未知（画板读不懂）排最后，同体量按名称；返回新数组。 */
export function bySizeDescending<T extends { name: string; bytes: number | null }>(boards: readonly T[]): T[] {
  return [...boards].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name));
}

