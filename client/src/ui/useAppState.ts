// 工作台的状态（#137）：从 src/App.tsx 拆出的 hook，让 App 只留接线。
// 状态多、判定少：拆成 hook 后 crapper 按函数各自计复杂度。
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { SizeTier } from "../core/boardSize";
import type { ConfirmItem } from "../core/submission";
import type { UiState } from "../core/uiState";
import { readStartup, restorePlan, shouldRecordVersion } from "./appStartup";

/** 工作台的状态与它的变更入口。 */
export interface AppState {
  settingsOpen: boolean;
  changelogOpen: boolean;
  lastSeenVersion: string | undefined;
  sizeNotices: Record<string, SizeTier>;
  boardListOpen: boolean;
  tidyKey: string | null;
  manageBoards: boolean;
  usageDismissed: SizeTier | null;
  packMenu: { x: number; y: number } | null;
  confirm: { boardKey: string; board: import("../core/board").Board; items: ConfirmItem[]; scope: "selection" | "board" } | null;
  sendText: ConfirmItem | null;
  tableError: string | null;
  fatal: string | null;
  ready: boolean;
  metadataReady: boolean;
  toastText: string | null;
  focus: { boardKey: string; nodeId: string; nonce: number } | null;
}

/** 状态与它的变更入口（一次拿全，App 里不再有一堆 useState）。 */
export interface AppStore {
  state: AppState;
  setSettingsOpen(open: boolean): void;
  setChangelogOpen(open: boolean): void;
  setLastSeenVersion(version: SetStateAction<string | undefined>): void;
  setSizeNotices(next: SetStateAction<Record<string, SizeTier>>): void;
  setBoardListOpen(open: boolean): void;
  setTidyKey(key: string | null): void;
  setManageBoards(manage: boolean): void;
  setUsageDismissed(level: SetStateAction<SizeTier | null>): void;
  setPackMenu(menu: { x: number; y: number } | null): void;
  setConfirm(confirm: AppState["confirm"]): void;
  setSendText(item: ConfirmItem | null): void;
  setTableError(error: string | null): void;
  setFatal(error: string | null): void;
  setReady(ready: boolean): void;
  setMetadataReady(ready: boolean): void;
  setToastText(text: string | null): void;
  setFocus(focus: SetStateAction<AppState["focus"]>): void;
  /** 启动时读到的界面状态（恢复标签页用）。 */
  initialUi: { current: UiState | null };
  /** 读界面状态失败（不记更新提示）。 */
  uiReadFailedRef: { current: boolean };
}

/** 工作台的状态。 */
export function useAppState(): AppStore {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [lastSeenVersion, setLastSeenVersion] = useState<string | undefined>();
  const [sizeNotices, setSizeNotices] = useState<Record<string, SizeTier>>({});
  const [boardListOpen, setBoardListOpen] = useState(false);
  const [tidyKey, setTidyKey] = useState<string | null>(null);
  const [manageBoards, setManageBoards] = useState(false);
  const [usageDismissed, setUsageDismissed] = useState<SizeTier | null>(null);
  const [packMenu, setPackMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<AppState["confirm"]>(null);
  const [sendText, setSendText] = useState<ConfirmItem | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const [focus, setFocus] = useState<AppState["focus"]>(null);
  const initialUi = useRef<UiState | null>(null);
  const uiReadFailedRef = useRef(false);
  return {
    state: {
      settingsOpen,
      changelogOpen,
      lastSeenVersion,
      sizeNotices,
      boardListOpen,
      tidyKey,
      manageBoards,
      usageDismissed,
      packMenu,
      confirm,
      sendText,
      tableError,
      fatal,
      ready,
      metadataReady,
      toastText,
      focus,
    },
    setSettingsOpen,
    setChangelogOpen,
    setLastSeenVersion,
    setSizeNotices,
    setBoardListOpen,
    setTidyKey,
    setManageBoards,
    setUsageDismissed,
    setPackMenu,
    setConfirm,
    setSendText,
    setTableError,
    setFatal,
    setReady,
    setMetadataReady,
    setToastText,
    setFocus,
    initialUi,
    uiReadFailedRef,
  };
}

/** 启动时读能力表覆盖与界面状态；读能力表覆盖失败只降级，读界面状态失败只标记。 */
export function useStartupReads(
  reads: { capabilityOverride(): Promise<string | null>; uiState(): Promise<string | null> },
  store: Pick<AppStore, "setTableError" | "setMetadataReady" | "setFatal" | "initialUi" | "uiReadFailedRef">,
  setTable: (table: import("../core/capabilities").CapabilityTable) => void,
): void {
  useEffect(() => {
    void (async () => {
      try {
        const startup = await readStartup(reads);
        setTable(startup.table);
        if (startup.tableError) store.setTableError(startup.tableError);
        store.initialUi.current = startup.ui;
        store.uiReadFailedRef.current = startup.uiReadFailed;
        store.setMetadataReady(true);
      } catch (e) {
        store.setFatal(String(e));
      }
    })();
  }, []);
}

/** 恢复标签页：照界面状态里的顺序打开，最后激活当前画板或新建一块。 */
export function useRestoreTabs(
  deps: {
    metadataReady: boolean;
    settingsLoaded: boolean;
    openPath(path: string, activate: boolean): Promise<boolean>;
    createBoardOrExplain(): Promise<void>;
    toast(message: string): void;
  },
  store: Pick<AppStore, "initialUi" | "setReady">,
): void {
  const started = useRef(false);
  useEffect(() => {
    if (!deps.metadataReady || !deps.settingsLoaded || started.current) return;
    started.current = true;
    void (async () => {
      const ui = store.initialUi.current!;
      const opened: string[] = [];
      for (const p of ui.open_boards) {
        try {
          if (await deps.openPath(p, false)) opened.push(p);
        } catch (e) {
          deps.toast(errorMessage(e));
        }
      }
      // 找不到的画板在这里提示（restorePlan 统一给出，不重复提示）。
      const plan = restorePlan(ui, opened);
      for (const notice of plan.notices) deps.toast(notice);
      if (plan.activate) await deps.openPath(plan.activate, true);
      else await deps.createBoardOrExplain();
      store.setReady(true);
    })();
  }, [deps.metadataReady, deps.settingsLoaded, deps.openPath, deps.createBoardOrExplain, deps.toast]);
}

/** 首次使用不提示更新，直接随界面状态记下当前版本。 */
export function useVersionNotice(
  metadataReady: boolean,
  version: string | null | undefined,
  lastSeenVersion: string | undefined,
  uiReadFailed: boolean,
  setLastSeenVersion: (version: string | undefined) => void,
): void {
  useEffect(() => {
    // 读界面状态失败时不知道是否新用户，不记，免得吞掉老用户这次的更新提示。
    if (metadataReady && shouldRecordVersion(version ?? undefined, lastSeenVersion, uiReadFailed)) setLastSeenVersion(version ?? undefined);
  }, [metadataReady, version, lastSeenVersion, uiReadFailed]);
}

/** 提示浮出 4 秒后自动消失。 */
export function useToastTimer(toastText: string | null, setToastText: (text: string | null) => void): void {
  useEffect(() => {
    if (!toastText) return;
    const timer = setTimeout(() => setToastText(null), 4000);
    return () => clearTimeout(timer);
  }, [toastText]);
}

/** 界面状态的串行写入：后写的覆盖先写的，不并发。 */
export function useUiStateWriter(write: () => Promise<void>): () => void {
  const chain = useRef(Promise.resolve());
  const persist = useCallback(() => {
    const next = chain.current.then(() => write());
    chain.current = next.catch(() => undefined);
    return next;
  }, [write]);
  return useCallback(() => void persist().catch(() => undefined), [persist]);
}

/** 错误的一句话说法。 */
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
