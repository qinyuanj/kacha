// 当前画板的画板体量（#87）：每次保存落盘后（版本变化）去抖向本机存储画板列表取一次，供越线提示用。
// 读不到（网络失败、画板不在画板目录里）时为 null，不提示；与生成无关，失败也不影响任何操作。
// 分档与换画板的判定在 ui/boardSizeRefresh.ts（#137），这里只管取数与去抖。
import { useEffect, useState } from "react";
import { useShell } from "./shell";
import { activeSizeOf, isSameBoardSize, type ActiveBoardSize } from "./boardSizeRefresh";

export type { ActiveBoardSize } from "./boardSizeRefresh";

/** 保存后等这么久再取：连续编辑时多次保存只问一次。 */
const REFRESH_DELAY_MS = 2000;

export function useActiveBoardSize(path: string | null, version: string | null): ActiveBoardSize | null {
  const port = useShell();
  const [size, setSize] = useState<ActiveBoardSize | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      port.board.list().then(
        (listing) => {
          if (cancelled) return;
          setSize(activeSizeOf(listing, path));
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
  return isSameBoardSize(size, path) ? size : null;
}
