// 更新面板的两个 hook（#164）：把「读状态 / 排程」与「安装流程」从组件里拆出来。
// 组件只摆放 DOM，复杂度单独看得到；两段各自可测。
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "./shell";
import { portFailureOf } from "../shell/port";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { createUpdateScheduler } from "../core/updateScheduler";
import { createUpdatePreparation, type UpdatePreparation, type UpdatePreparationPorts } from "../core/updatePreparation";

/** 轮询间隔：下载进度要动，但不该压着界面。 */
const POLL_MS = 500;
/** 空闲时的轮询间隔：只为拿到别处（例如手动检查）造成的变化。 */
const IDLE_POLL_MS = 5000;

/** 快照是否在动：检查中、下载中、安装中都要勤读。 */
function isBusy(phase: UpdateSnapshot["phase"]): boolean {
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

/** 读当前快照，并负责排程：启动约 3 秒检查一次，之后每次检查结束约 6 小时再检查。 */
export function useUpdateSnapshot(): { snapshot: UpdateSnapshot; refresh: () => Promise<void> } {
  const port = useShell();
  const [snapshot, setSnapshot] = useState<UpdateSnapshot>(() => emptySnapshot());
  // 排程按 checked_at 决定下一次：用 ref 读到最新快照，不依赖旧闭包。
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // 读一次快照；失败时不改快照（服务不可用已在能力开关里体现）。
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await port.update.status());
    } catch {
      // 轮询失败不打断界面：下一次再读。
    }
  }, [port]);

  const enabled = port.features.update === true;
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const scheduler = createUpdateScheduler({
      snapshot: () => snapshotRef.current,
      check: () => void port.update.check().catch(() => undefined),
      schedule: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      now: () => Date.now(),
    });
    return scheduler.start();
  }, [enabled, port, refresh]);

  const busy = isBusy(snapshot.phase);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refresh(), busy ? POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh, busy]);

  return { snapshot, refresh };
}

/** 安装流程的结局：准备被拒的原因，或安装 / 检查失败的原因。 */
export interface InstallState {
  preparing: boolean;
  prepareError: string;
  installError: string;
}

/** 检查与安装两个动作；安装前先走准备（拒绝新任务、等在途操作、严格保存）。 */
export function useUpdateActions(deps: UpdatePreparationPorts, refresh: () => Promise<void>) {
  const port = useShell();
  const [state, setState] = useState<InstallState>({ preparing: false, prepareError: "", installError: "" });
  const preparation = useRef<UpdatePreparation | null>(null);

  const check = useCallback(async () => {
    setState((s) => ({ ...s, installError: "" }));
    try {
      await port.update.check();
      await refresh();
    } catch (e) {
      setState((s) => ({ ...s, installError: portFailureOf(e).message || "检查更新失败" }));
    }
  }, [port, refresh]);

  const install = useCallback(async () => {
    setState({ preparing: true, prepareError: "", installError: "" });
    const coordinator = preparation.current ?? createUpdatePreparation(deps);
    preparation.current = coordinator;
    try {
      const result = await coordinator.installGuard();
      if (!result.allowed) {
        setState({ preparing: false, prepareError: result.reason ?? "更新准备失败", installError: "" });
        return;
      }
      await port.update.install();
      setState({ preparing: false, prepareError: "", installError: "" });
    } catch (e) {
      // 安装失败：解除保护，旧版本照常可用。
      coordinator.release();
      preparation.current = null;
      setState({ preparing: false, prepareError: "", installError: portFailureOf(e).message || "安装失败" });
    } finally {
      await refresh();
    }
  }, [deps, port, refresh]);

  return { state, check, install };
}
