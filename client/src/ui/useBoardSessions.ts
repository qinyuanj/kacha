// 多画板标签页：打开 / 新建 / 关闭 / 重命名 / 删除 / 去抖自动保存 / 另存到。
// 各个操作在 ui/boardSessionsOps.ts（#137），hook 只留接线。
import { useCallback, useRef, useState } from "react";
import type { Board } from "../core/board";
import type { BoardChange, EditEnv, EditResult } from "../core/edit";
import { newId } from "../core/ids";
import { redo, undo, type History } from "../core/history";
import { basename, resolveFromRoot } from "../core/paths";
import { serializeBoard } from "../core/board";
import { sha256Hex } from "../core/sha256";
import { knownImageInfo } from "./context";
import { useShell } from "./shell";
import { errorText } from "../core/errors";
import { isReadOnly, isMissing, samePath, saveErrorFlags, saveErrorText } from "./boardSessions";
import {
  applyChange,
  archiveBoardSession,
  checkChange,
  copyAsNewBoardSession,
  createBoardSession,
  deleteBoardSession,
  moveOutStageSession,
  openBoardPath,
  reloadBoardSession,
  renameBoardSession,
  travelHistory,
  unarchiveBoardSession,
  type SessionPorts,
  type SessionStore,
} from "./boardSessionsOps";

export const AUTOSAVE_DEBOUNCE_MS = 1000;

export type Session =
  | {
      key: string;
      path: string;
      status: "ok";
      board: Board;
      history: History;
      notice: string | null;
      saveError: string | null;
      version: string | null;
      conflicted: boolean;
      /** 服务端已没有这块画板（在别处删除或改名）：不能重新载入，只能导出画板包或关闭。 */
      missing: boolean;
    }
  | { key: string; path: string; status: "newer"; version: number }
  | { key: string; path: string; status: "corrupt"; reason: string };

export type OkSession = Extract<Session, { status: "ok" }>;

/** 编辑环境里随应用状态变化的部分：能力表、网关发现、该画板的锁定集（排队 / 执行 / 限流退避中的任务节点）。 */
export type EnvSource = (key: string) => Pick<EditEnv, "table" | "discovery" | "locked">;

interface Saver {
  timer: ReturnType<typeof setTimeout> | null;
  /** 串行化同一画板的写入，避免旧写入覆盖新写入。 */
  chain: Promise<void>;
}

/** 会话状态与查找。 */
export function useSessionState(): SessionStore & { sessions: Session[] } {
  const [sessions, setSessionsState] = useState<Session[]>([]);
  const sessionsRef = useRef<Session[]>([]);
  const setSessions = useCallback((next: Session[]) => {
    sessionsRef.current = next;
    setSessionsState(next);
  }, []);
  /** 改一块画板的状态；只有 ok 会话会被改。 */
  const patch = useCallback(
    (key: string, fn: (s: OkSession) => OkSession) => {
      setSessions(sessionsRef.current.map((s) => (s.key === key && s.status === "ok" ? { ...fn(s) } : s)));
    },
    [setSessions],
  );
  const sessionOf = useCallback((key: string) => sessionsRef.current.find((x) => x.key === key), []);
  return { sessions, sessionsRef, setSessions, patch, sessionOf };
}

/** 去抖自动保存：每块画板一个计时器与一条串行写入链。 */
export function useAutosave(
  patch: (key: string, fn: (s: OkSession) => OkSession) => void,
  sessionOf: (key: string) => Session | undefined,
  isReadOnlyPath: (path: string) => boolean,
  port: ReturnType<typeof useShell>,
) {
  const savers = useRef(new Map<string, Saver>());
  const saverOf = (key: string): Saver => {
    let saver = savers.current.get(key);
    if (!saver) {
      saver = { timer: null, chain: Promise.resolve() };
      savers.current.set(key, saver);
    }
    return saver;
  };
  /** 唯一写入实现：带内容版本（新建则只新建不覆盖），成功后用同一算法回写新版本。 */
  const writeSession = async (key: string, s: OkSession) => {
    const text = serializeBoard(s.board);
    await port.board.write(s.path, text, s.version ? { version: s.version } : { createOnly: true });
    const version = await sha256Hex(new TextEncoder().encode(text));
    patch(key, (x) => (samePath(x.path, s.path) ? { ...x, version, saveError: null } : x));
  };
  const flush = useCallback(
    (key: string): Promise<void> => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = null;
      saver.chain = saver.chain.then(async () => {
        // 写入时再取最新会话：路径可能刚被重命名或另存。
        const s = sessionOf(key);
        // 归档画板只读（#90）：从不写回，服务端也会拒绝。
        if (!s || s.status !== "ok" || s.conflicted || isReadOnlyPath(s.path)) return;
        try {
          await writeSession(key, s);
        } catch (e) {
          port.ui.log("board_save_failed", { board_file: basename(s.path), reason: "autosave", message: errorText(e) });
          patch(key, (x) => ({ ...x, saveError: saveErrorText(s.path, errorText(e), isMissing(e)), ...saveErrorFlags(e) }));
        }
      });
      return saver.chain;
    },
    [patch, sessionOf, isReadOnlyPath],
  );
  const scheduleSave = useCallback(
    (key: string) => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = setTimeout(() => void flush(key), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );
  /** 关闭全部标签页（切换用户数据根时用）；先落盘。 */
  const flushAll = useCallback(async () => {
    const pending = [...savers.current.entries()].filter(([, s]) => s.timer !== null).map(([key]) => flush(key));
    await Promise.all([...pending, ...[...savers.current.values()].map((s) => s.chain)]);
  }, [flush]);
  /** 停掉一块画板的待写计时器（关标签页时）。 */
  const cancelTimer = useCallback((key: string) => {
    const saver = savers.current.get(key);
    if (saver?.timer) clearTimeout(saver.timer);
    savers.current.delete(key);
  }, []);
  return { flush, scheduleSave, flushAll, cancelTimer, savers, saverOf };
}

/** 当前会话的切换。 */
export function useActiveSession() {
  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const setActiveKey = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    activeKeyRef.current = typeof next === "function" ? next(activeKeyRef.current) : next;
    setActiveKeyState(activeKeyRef.current);
  }, []);
  return { activeKey, activeKeyRef, setActiveKey };
}

export function useBoardSessions(userRoot: string | null, envSource: EnvSource, onMoved: (from: string, to: string) => void = () => undefined) {
  const port = useShell();
  const movingSessions = useRef(new Set<string>());
  const movingOut = useRef(false);
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  const { activeKey, activeKeyRef, setActiveKey } = useActiveSession();
  const store = useSessionState();
  const userRootRef = useRef(userRoot);
  userRootRef.current = userRoot;
  const readOnlyPath = useCallback((path: string) => isReadOnly(userRootRef.current, path), []);
  const { flush, scheduleSave, flushAll, cancelTimer, saverOf } = useAutosave(store.patch, store.sessionOf, readOnlyPath, port);
  const ports: SessionPorts = port;

  const envSourceRef = useRef(envSource);
  envSourceRef.current = envSource;
  /** 按画板组装编辑环境：图片宽高只取已读到的；锁定集取该画板的（ADR 0015）。 */
  const envOf = useCallback(
    (key: string): EditEnv => ({
      ...envSourceRef.current(key),
      imageSize: (path) => {
        const root = userRootRef.current;
        const info = root ? knownImageInfo(resolveFromRoot(root, path)) : undefined;
        return info ? [info.width, info.height] : undefined;
      },
      newId,
    }),
    [],
  );

  /** 按当前画板试算一次变更，不写入（删除前的确认判断用）；会话不可编辑时为 null。 */
  const check = useCallback(
    (key: string, change: BoardChange): EditResult | null => checkChange(store, envOf(key), key, change),
    [envOf, store],
  );

  /** 画板写入的唯一入口（ADR 0014）：经画板编辑算出新画板，落撤销步，排程去抖保存。会话不可编辑时为 null。 */
  const apply = useCallback(
    (key: string, change: BoardChange): EditResult | null => applyChange(store, envOf(key), scheduleSave, readOnlyPath, movingSessions.current, key, change),
    [envOf, store, scheduleSave, readOnlyPath],
  );

  /** 撤销 / 重做一步；锁定任务的参数与输入连线按当前状态保留。 */
  const travel = useCallback(
    (key: string, direction: typeof undo) => travelHistory(store, direction, envSourceRef.current(key).locked, scheduleSave, readOnlyPath, movingSessions.current, key),
    [store, scheduleSave, readOnlyPath],
  );
  const undoBoard = useCallback((key: string) => travel(key, undo), [travel]);
  const redoBoard = useCallback((key: string) => travel(key, redo), [travel]);

  /** 最新的画板内容（不等 React 重渲染）；会话不存在或不可编辑时为 null。 */
  const getBoard = useCallback((key: string): Board | null => {
    const s = store.sessionOf(key);
    return s?.status === "ok" ? s.board : null;
  }, [store]);

  /** 画板文件名（日志用，不带目录）；会话不存在时为 null。 */
  const boardFileName = useCallback((key: string): string | null => {
    const s = store.sessionOf(key);
    return s ? basename(s.path) : null;
  }, [store]);

  const closeBoardRef = useRef<(key: string) => Promise<void>>(async () => undefined);
  /** 关闭全部标签页（切换用户数据根时用）；先落盘。 */
  const closeAll = useCallback(async () => {
    for (const s of store.sessionsRef.current) await closeBoardRef.current(s.key);
  }, [store]);

  /** 打开画板文件；已打开则切过去。主文件与 .bak 都不存在时返回 false。 */
  const openPath = useCallback(
    async (path: string, activate = true): Promise<boolean> => openBoardPath(store, ports, userRootRef.current, activate, setActiveKey, path),
    [store, setActiveKey],
  );

  /** 新建画板并立即落盘占住文件名。画板位满时返回统一文案（#89）。 */
  const createBoard = useCallback(async (): Promise<string | null> => createBoardSession(store, ports, userRoot, flush, setActiveKey), [store, flush, setActiveKey]);

  /** 移出为新画板（#93）。 */
  const moveOutStage = useCallback(
    async (key: string, stageId: string): Promise<string> =>
      moveOutStageSession(store, ports, envOf(key), userRootRef.current, readOnlyPath, movingSessions.current, movingOut, apply, key, stageId),
    [store, envOf, apply, readOnlyPath],
  );

  /** 导入画板由服务端在锁内写好；本页只打开返回路径。 */
  const openImportedBoard = useCallback(async (path: string): Promise<void> => {
    if (!userRoot) throw new Error("用户数据根未就绪");
    if (!await openPath(resolveFromRoot(userRoot, path), true)) throw new Error("导入画板已写入但无法打开，请重新载入画板列表");
  }, [openPath, userRoot]);

  /** 关掉标签页且不再保存：画板已删除，或用户放弃一块服务端已不存在的画板。 */
  const dropSession = useCallback(
    (key: string) => {
      cancelTimer(key);
      const list = store.sessionsRef.current;
      const index = list.findIndex((s) => s.key === key);
      const next = list.filter((s) => s.key !== key);
      store.setSessions(next);
      setActiveKey((active) => (active === key ? (next[Math.min(index, next.length - 1)]?.key ?? null) : active));
    },
    [store, setActiveKey, cancelTimer],
  );

  const closeBoard = useCallback(
    async (key: string) => {
      const saver = saverOf(key);
      if (saver?.timer) await flush(key);
      else if (saver) await saver.chain;
      // 保存失败不能丢改动：标签页留着，修好后重试或先导出画板包。
      const current = store.sessionOf(key);
      if (current?.status === "ok" && current.saveError) return;
      dropSession(key);
    },
    [flush, store, dropSession, saverOf],
  );

  /** 删除本页已打开的画板：先保存未保存的改动，再带最新版本删除（进回收区的是最新内容），成功后关闭标签页。 */
  const deleteBoard = useCallback(
    async (key: string) => deleteBoardSession(store, ports, flush, dropSession, key),
    [store, flush, dropSession],
  );

  /** 本页打开的会话换到新位置（归档 / 取消归档后），内容与撤销历史照旧。 */
  const movedTo = useCallback((from: string, to: string) => {
    const s = store.sessionsRef.current.find((x) => samePath(x.path, from));
    if (s) store.setSessions(store.sessionsRef.current.map((x) => (x.key === s.key ? { ...x, path: to } : x)));
    onMovedRef.current(from, to);
  }, [store]);

  /** 归档（#90）：本页开着的先保存再带版本搬，标签页留着、变为只读。 */
  const archiveBoard = useCallback(
    async (path: string) => archiveBoardSession(store, ports, userRoot, flush, movingSessions.current, movedTo, path),
    [store, flush, movedTo],
  );

  /** 取消归档：画板位满时返回统一文案；成功为 null。 */
  const unarchiveBoard = useCallback(
    async (path: string): Promise<string | null> => unarchiveBoardSession(store, ports, userRoot, movedTo, path),
    [store, movedTo],
  );

  /** 复制为新画板：归档画板内容只新建写进画板目录并打开，原画板不动。 */
  const copyAsNewBoard = useCallback(
    async (path: string): Promise<string | null> => copyAsNewBoardSession(store, ports, userRoot, openPath, path),
    [store, openPath],
  );

  closeBoardRef.current = closeBoard;

  /** 本页打开该路径画板的标签页 key；没打开为 null。 */
  const keyOf = useCallback((path: string): string | null => store.sessionsRef.current.find((s) => samePath(s.path, path))?.key ?? null, [store]);

  /** 改标题：文件名由标题派生，重名加 (2)，连同 .bak 一起改名。 */
  const renameBoard = useCallback(
    async (key: string, rawTitle: string) => renameBoardSession(store, ports, flush, apply, movedTo, readOnlyPath, movingSessions.current, key, rawTitle),
    [store, flush, apply, movedTo, readOnlyPath],
  );

  const dismissNotice = useCallback((key: string) => store.patch(key, (x) => ({ ...x, notice: null })), [store]);

  /** 保存失败后显式重试：改动一直在页面里，这里只是再写一次。 */
  const retrySave = useCallback(async (key: string) => {
    await flush(key);
  }, [flush]);

  /** 冲突后由用户显式重新载入服务端的画板；本页未保存的改动随之放弃（不做自动合并）。 */
  const reload = useCallback(async (key: string) => reloadBoardSession(store, ports, userRootRef.current, movingSessions.current, key), [store]);

  return {
    sessions: store.sessions,
    activeKey,
    setActiveKey,
    openPath,
    createBoard,
    moveOutStage,
    openImportedBoard,
    closeBoard,
    deleteBoard,
    archiveBoard,
    unarchiveBoard,
    copyAsNewBoard,
    dropSession,
    keyOf,
    renameBoard,
    apply,
    check,
    undoBoard,
    redoBoard,
    getBoard,
    boardFileName,
    closeAll,
    flushAll,
    flushNow: flush,
    retrySave,
    reload,
    dismissNotice,
    snapshot: () => ({ sessions: store.sessionsRef.current, activeKey: activeKeyRef.current }),
  };
}
