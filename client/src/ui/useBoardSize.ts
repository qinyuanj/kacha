// 当前画板的画板体量（#87）：每次保存落盘后（版本变化）去抖向服务端画板列表取一次，供越线提示用。
// 读不到（网络失败、画板不在画板目录里）时为 null，不提示；与生成无关，失败也不影响任何操作。
import { useEffect, useState } from "react";
import { sizeTier, type SizeTier } from "../core/boardSize";
import { ipc } from "../shell/ipc";

/** 保存后等这么久再取：连续编辑时多次保存只问一次。 */
const REFRESH_DELAY_MS = 2000;

export interface ActiveBoardSize {
  path: string;
  bytes: number;
  tier: SizeTier | null;
}

export function useActiveBoardSize(path: string | null, version: string | null): ActiveBoardSize | null {
  const [size, setSize] = useState<ActiveBoardSize | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      ipc.listBoards().then(
        (listing) => {
          if (cancelled) return;
          const entry = listing.boards.find((b) => b.path === path);
          setSize(entry && entry.bytes !== null ? { path, bytes: entry.bytes, tier: sizeTier(entry.bytes, listing.size_lines) } : null);
        },
        () => undefined,
      );
    }, REFRESH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, version]);
  // 换了画板、旧画板的结果还没换掉时不当成新画板的体量。
  return size && size.path === path ? size : null;
}
