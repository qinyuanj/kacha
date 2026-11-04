// 多画板标签页：打开 / 新建 / 关闭 / 重命名 / 去抖自动保存 / 另存到。
import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_BOARD_TITLE,
  newBoard,
  openBoard,
  serializeBoard,
  uniqueBoardFileName,
  type Board,
} from "../core/board";
import { editBoard, type BoardChange, type EditEnv, type EditResult } from "../core/edit";
import { newId } from "../core/ids";
import { emptyHistory, recordChange, redo, undo, type History } from "../core/history";
import { basename, boardsDir, dirname, joinPath, resolveFromRoot } from "../core/paths";
import { restoreResultLayers } from "../core/taskDir";
import { sha256Hex } from "../core/sha256";
import { ipc } from "../shell/ipc";
import { ApiError } from "../shell/apiError";
import { logEvent } from "../shell/log";
import { knownImageInfo } from "./context";

export const AUTOSAVE_DEBOUNCE_MS = 1000;

export type Session =
  | { key: string; path: string; status: "ok"; board: Board; history: History; notice: string | null; saveError: string | null; version: string | null; conflicted: boolean }
  | { key: string; path: string; status: "newer"; version: number }
  | { key: string; path: string; status: "corrupt"; reason: string };

export type OkSession = Extract<Session, { status: "ok" }>;

interface Saver {
  timer: ReturnType<typeof setTimeout> | null;
  /** 串行化同一画板的写入，避免旧写入覆盖新写入。 */
  chain: Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** 编辑环境里随应用状态变化的部分：能力表、网关发现、该画板的锁定集（排队 / 执行 / 限流退避中的任务节点）。 */
export type EnvSource = (key: string) => Pick<EditEnv, "table" | "discovery" | "locked">;

export function useBoardSessions(outputRoot: string | null, envSource: EnvSource) {
  const [sessions, setSessionsState] = useState<Session[]>([]);
  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const setActiveKey = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    activeKeyRef.current = typeof next === "function" ? next(activeKeyRef.current) : next;
    setActiveKeyState(activeKeyRef.current);
  }, []);
  const sessionsRef = useRef<Session[]>([]);
  const savers = useRef(new Map<string, Saver>());
  const setSessions = useCallback((next: Session[]) => {
    sessionsRef.current = next;
    setSessionsState(next);
  }, []);

  const patch = useCallback(
    (key: string, fn: (s: OkSession) => OkSession) => {
      setSessions(sessionsRef.current.map((s) => (s.key === key && s.status === "ok" ? { ...fn(s) } : s)));
    },
    [setSessions],
  );

  const saverOf = (key: string): Saver => {
    let saver = savers.current.get(key);
    if (!saver) {
      saver = { timer: null, chain: Promise.resolve() };
      savers.current.set(key, saver);
    }
    return saver;
  };

  /** 409 = 过期保存 / 旧名已改名 / 同名已存在：不自动合并，也不再自动重试，等用户重新载入或改名。 */
  const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;

  /** 唯一写入实现：带内容版本（新建则只新建不覆盖），成功后用同一算法回写新版本。 */
  const writeSession = async (key: string, s: OkSession) => {
    const text = serializeBoard(s.board);
    await ipc.writeBoard(s.path, text, s.version ? { version: s.version } : { createOnly: true });
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
        const s = sessionsRef.current.find((x) => x.key === key);
        if (!s || s.status !== "ok" || s.conflicted) return;
        try {
          await writeSession(key, s);
        } catch (e) {
          logEvent("board_save_failed", { board_file: basename(s.path), reason: "autosave", message: errorText(e) });
          patch(key, (x) => ({ ...x, saveError: `未能保存到 ${s.path}：${errorText(e)}`, ...(isConflict(e) ? { conflicted: true } : {}) }));
        }
      });
      return saver.chain;
    },
    [patch],
  );

  const scheduleSave = useCallback(
    (key: string) => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = setTimeout(() => void flush(key), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const envSourceRef = useRef(envSource);
  envSourceRef.current = envSource;
  const outputRootRef = useRef(outputRoot);
  outputRootRef.current = outputRoot;
  /** 按画板组装编辑环境：图片宽高只取已读到的；锁定集取该画板的（ADR 0015）。 */
  const envOf = useCallback(
    (key: string): EditEnv => ({
      ...envSourceRef.current(key),
      imageSize: (path) => {
        const root = outputRootRef.current;
        const info = root ? knownImageInfo(resolveFromRoot(root, path)) : undefined;
        return info ? [info.width, info.height] : undefined;
      },
      newId,
    }),
    [],
  );

  /** 按当前画板试算一次变更，不写入（删除前的确认判断用）；会话不可编辑时为 null。 */
  const check = useCallback(
    (key: string, change: BoardChange): EditResult | null => {
      const s = sessionsRef.current.find((x) => x.key === key);
      return s?.status === "ok" ? editBoard(s.board, change, envOf(key)) : null;
    },
    [envOf],
  );

  /** 画板写入的唯一入口（ADR 0014）：经画板编辑算出新画板，落撤销步（只有用户变更有），排程去抖保存。会话不可编辑时为 null。 */
  const apply = useCallback(
    (key: string, change: BoardChange): EditResult | null => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return null;
      const r = editBoard(s.board, change, envOf(key));
      if (r.board === s.board) return r;
      patch(key, (x) => ({ ...x, board: r.board, history: r.step ? recordChange(x.history, s.board, r.step, Date.now()) : x.history }));
      scheduleSave(key);
      return r;
    },
    [envOf, patch, scheduleSave],
  );

  /** 撤销 / 重做一步；锁定任务的参数与输入连线按当前状态保留。 */
  const travel = useCallback(
    (key: string, direction: typeof undo) => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      const r = direction(s.history, s.board, envSourceRef.current(key).locked);
      if (!r) return;
      patch(key, (x) => ({ ...x, board: r.board, history: r.history }));
      scheduleSave(key);
    },
    [patch, scheduleSave],
  );
  const undoBoard = useCallback((key: string) => travel(key, undo), [travel]);
  const redoBoard = useCallback((key: string) => travel(key, redo), [travel]);

  /** 最新的画板内容（不等 React 重渲染）；会话不存在或不可编辑时为 null。 */
  const getBoard = useCallback((key: string): Board | null => {
    const s = sessionsRef.current.find((x) => x.key === key);
    return s?.status === "ok" ? s.board : null;
  }, []);

  /** 画板文件名（日志用，不带目录）；会话不存在时为 null。 */
  const boardFileName = useCallback((key: string): string | null => {
    const s = sessionsRef.current.find((x) => x.key === key);
    return s ? basename(s.path) : null;
  }, []);

  /** 关闭全部标签页（切换输出根目录时用）；先落盘。 */
  const closeAll = useCallback(async () => {
    for (const s of sessionsRef.current) await closeBoardRef.current(s.key);
  }, []);
  const closeBoardRef = useRef<(key: string) => Promise<void>>(async () => undefined);

  /** 普通关窗 / 导出入口：吞掉失败，只保证计时器与在途写入做完。 */
  const flushAll = useCallback(async () => {
    const pending = [...savers.current.entries()].filter(([, s]) => s.timer !== null).map(([key]) => flush(key));
    await Promise.all([...pending, ...[...savers.current.values()].map((s) => s.chain)]);
  }, [flush]);

  /** 打开画板文件；已打开则切过去。主文件与 .bak 都不存在时返回 false。 */
  const openPath = useCallback(
    async (path: string, activate = true): Promise<boolean> => {
      const existing = sessionsRef.current.find((s) => samePath(s.path, path));
      if (existing) {
        if (activate) setActiveKey(existing.key);
        return true;
      }
      const texts = await ipc.readBoard(path);
      if (texts.main === null && texts.bak === null) return false;
      const opened = openBoard(texts.main, texts.bak);
      // 任务目录是真源：Flash 结果的图层身份 / 定位按 layers.json 还原（画板只冗余展示）；画板包导入同走这里。
      if (opened.kind === "ok" && outputRootRef.current) {
        try {
          opened.board = await restoreResultLayers({ readFile: ipc.readFileBytes }, outputRootRef.current, opened.board);
        } catch (e) {
          throw new Error(`打开画板失败：${errorText(e)}`);
        }
      }
      const key = newId();
      const session: Session =
        opened.kind === "ok"
          ? {
              key,
              path,
              status: "ok",
              board: opened.board,
              history: emptyHistory(),
              notice: opened.recoveredFromBak ? "画板主文件已损坏，已从备份 .bak 恢复；下次保存会写回主文件。" : null,
              saveError: null,
              version: texts.version ?? null,
              conflicted: false,
            }
          : opened.kind === "newer"
            ? { key, path, status: "newer", version: opened.version }
            : { key, path, status: "corrupt", reason: opened.reason };
      setSessions([...sessionsRef.current, session]);
      if (activate) setActiveKey(key);
      return true;
    },
    [setSessions],
  );

  const createBoard = useCallback(async () => {
    if (!outputRoot) return;
    const dir = boardsDir(outputRoot);
    const onDisk = await ipc.listBoardNames(dir).catch(() => [] as string[]);
    const openHere = sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
    const path = joinPath(dir, uniqueBoardFileName(DEFAULT_BOARD_TITLE, [...onDisk, ...openHere]));
    const key = newId();
    setSessions([...sessionsRef.current, { key, path, status: "ok", board: newBoard(), history: emptyHistory(), notice: null, saveError: null, version: null, conflicted: false }]);
    setActiveKey(key);
    // 立即落盘占住文件名。
    await flush(key);
  }, [outputRoot, flush, setSessions]);

  /** 导入的画板写进输出根目录画板目录：同名沿用 (2) 自动改名、永不覆盖；写好后在新标签页打开。 */
  const addImportedBoard = useCallback(
    async (board: Board): Promise<string> => {
      if (!outputRoot) throw new Error("输出根目录未就绪");
      const dir = boardsDir(outputRoot);
      const onDisk = await ipc.listBoardNames(dir);
      const openHere = sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
      const path = joinPath(dir, uniqueBoardFileName(board.title, [...onDisk, ...openHere]));
      await ipc.writeBoard(path, serializeBoard(board));
      await openPath(path, true);
      return path;
    },
    [outputRoot, openPath],
  );

  const closeBoard = useCallback(
    async (key: string) => {
      const saver = savers.current.get(key);
      if (saver?.timer) await flush(key);
      else if (saver) await saver.chain;
      // 保存失败不能丢改动：标签页留着，修好后重试或先导出画板包。
      const current = sessionsRef.current.find((s) => s.key === key);
      if (current?.status === "ok" && current.saveError) return;
      savers.current.delete(key);
      const list = sessionsRef.current;
      const index = list.findIndex((s) => s.key === key);
      const next = list.filter((s) => s.key !== key);
      setSessions(next);
      setActiveKey((active) => (active === key ? (next[Math.min(index, next.length - 1)]?.key ?? null) : active));
    },
    [flush, setSessions],
  );

  closeBoardRef.current = closeBoard;

  /** 改标题：文件名由标题派生，重名加 (2)，连同 .bak 一起改名。 */
  const renameBoard = useCallback(
    async (key: string, rawTitle: string) => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      const title = rawTitle.trim() || DEFAULT_BOARD_TITLE;
      if (title === s.board.title) return;
      // 先落盘挂起的修改，避免去抖写入在改名途中把旧文件重新写出来。
      await flush(key);
      const dir = dirname(s.path);
      const self = basename(s.path);
      const onDisk = await ipc.listBoardNames(dir).catch(() => [] as string[]);
      const openHere = sessionsRef.current.filter((x) => x.key !== key && samePath(dirname(x.path), dir)).map((x) => basename(x.path));
      const nextPath = joinPath(dir, uniqueBoardFileName(title, [...onDisk, ...openHere], self));
      try {
        if (nextPath !== s.path) await ipc.renameBoard(s.path, nextPath, s.version ?? undefined);
      } catch (e) {
        patch(key, (x) => ({ ...x, notice: `重命名失败：${errorText(e)}` }));
        return;
      }
      patch(key, (x) => ({ ...x, path: nextPath }));
      apply(key, { kind: "title", title });
      await flush(key);
    },
    [flush, patch, apply],
  );

  const dismissNotice = useCallback((key: string) => patch(key, (x) => ({ ...x, notice: null })), [patch]);

  /** 保存失败后显式重试：改动一直在页面里，这里只是再写一次。 */
  const retrySave = useCallback(async (key: string) => {
    await flush(key);
  }, [flush]);

  /** 冲突后由用户显式重新载入服务端的画板；本页未保存的改动随之放弃（不做自动合并）。 */
  const reload = useCallback(async (key: string) => {
    const s = sessionsRef.current.find((x) => x.key === key);
    if (!s || s.status !== "ok") return;
    try {
      const texts = await ipc.readBoard(s.path);
      const opened = openBoard(texts.main, texts.bak);
      if (opened.kind !== "ok") {
        patch(key, (x) => ({ ...x, notice: `重新载入失败：${opened.kind === "newer" ? `画板格式版本 ${opened.version} 高于本应用` : opened.reason}` }));
        return;
      }
      if (outputRootRef.current) opened.board = await restoreResultLayers({ readFile: ipc.readFileBytes }, outputRootRef.current, opened.board);
      patch(key, (x) => ({ ...x, board: opened.board, history: emptyHistory(), version: texts.version ?? null, saveError: null, conflicted: false, notice: null }));
    } catch (e) {
      patch(key, (x) => ({ ...x, notice: `重新载入失败：${errorText(e)}` }));
    }
  }, [patch]);

  return {
    sessions,
    activeKey,
    setActiveKey,
    openPath,
    createBoard,
    addImportedBoard,
    closeBoard,
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
    snapshot: () => ({ sessions: sessionsRef.current, activeKey: activeKeyRef.current }),
  };
}
