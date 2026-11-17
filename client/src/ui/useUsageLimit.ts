// 用量上限提醒（#88）：打开页面时、之后每隔一段时间、以及用户整理完画板后向本机存储取一次用量。
// 档位由本机存储按配置算好（上限留空即不提醒）；读不到时不提醒。只提醒，与生成无关，失败也不影响任何操作。
// 分档在 ui/usageLimitNotice.ts（#137），这里只管取数与轮询。
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "./shell";
import { usageNoticeOf, type UsageLimitNotice } from "./usageLimitNotice";

export type { UsageLimitNotice } from "./usageLimitNotice";

/** 用量统计要扫一遍数据根，不必频繁：生成在持续增长用量，十分钟一次足够及时。 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function useUsageLimit(enabled: boolean): { notice: UsageLimitNotice | null; refresh(): void } {
  const port = useShell();
  const [notice, setNotice] = useState<UsageLimitNotice | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    port.usage.usage().then(
      (u) => {
        if (mine !== seq.current) return;
        setNotice(usageNoticeOf(u));
      },
      () => undefined,
    );
  }, []);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { notice, refresh };
}
