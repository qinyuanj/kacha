// 当前画板体量的读取与分档（#137）：从 useBoardSize 拆出的纯逻辑，便于单测。
import { sizeTier, type SizeTier } from "../core/boardSize";
import type { BoardListing } from "../shell/types";

export interface ActiveBoardSize {
  path: string;
  bytes: number;
  tier: SizeTier | null;
}

/** 画板列表里这一块的体量与档位：列表里没有它、或体量未知（画板读不懂）时为 null。 */
export function activeSizeOf(listing: BoardListing, path: string): ActiveBoardSize | null {
  const entry = listing.boards.find((b) => b.path === path);
  if (!entry || entry.bytes === null) return null;
  return { path, bytes: entry.bytes, tier: sizeTier(entry.bytes, listing.size_lines) };
}

/** 换了画板、旧画板的结果还没换掉时不当成新画板的体量。 */
export function isSameBoardSize(size: ActiveBoardSize | null, path: string | null): boolean {
  return !!size && size.path === path;
}
