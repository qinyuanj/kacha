// 空闲自动安装的接线（#180）：判定与计时都在 core/updateAutoInstall.ts，这里只接计时器与重绘。
//
// 依赖从 ref 读最新的一份：计时器每秒推进时不该被旧的闭包钉住。
import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateSnapshot } from "../core/update";
import {
  createAutoInstall,
  IDLE_AUTO_VIEW,
  sameAutoInstallView,
  type AutoInstall,
  type AutoInstallView,
  type InstallOutcome,
  type UpdateIdleFacts,
} from "../core/updateAutoInstall";

/** 多久推进一次：倒计时的秒数要动，任务结束与落盘恢复也要及时看到。 */
export const AUTO_INSTALL_POLL_MS = 500;

/** 自动安装要的东西：快照、第一份快照读没读到、空闲依据与真正的安装动作。 */
export interface AutoInstallDeps {
  snapshot: UpdateSnapshot;
  loaded: boolean;
  /** 取最新的空闲依据：任务份数与未落盘的改动。 */
  idle(): UpdateIdleFacts;
  install(): Promise<InstallOutcome>;
}

/** 空闲自动安装：界面拿到的样子与「稍后」。 */
export function useUpdateAutoInstall(deps: AutoInstallDeps): { view: AutoInstallView; defer(): void } {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [view, setView] = useState<AutoInstallView>(IDLE_AUTO_VIEW);
  const [machine] = useState<AutoInstall>(() =>
    createAutoInstall({
      now: () => Date.now(),
      install: () => depsRef.current.install(),
      changed: (next) => setView((prev) => (sameAutoInstallView(prev, next) ? prev : next)),
    }),
  );

  /** 推进一步：读最新快照与空闲依据，交给状态机判定。 */
  const pump = useCallback(() => {
    const current = depsRef.current;
    const next = machine.pump({ snapshot: current.snapshot, loaded: current.loaded, ...current.idle() });
    setView((prev) => (sameAutoInstallView(prev, next) ? prev : next));
  }, [machine]);

  // 快照一变就重判一次，另外每半秒推进一步（倒计时与条件恢复都靠它）。
  const { snapshot, loaded } = deps;
  useEffect(() => {
    pump();
    const timer = setInterval(pump, AUTO_INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [pump, snapshot, loaded]);

  const defer = useCallback(() => machine.defer(), [machine]);
  return { view, defer };
}
