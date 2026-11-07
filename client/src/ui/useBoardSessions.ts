// 多画板标签页：打开 / 新建 / 关闭 / 重命名 / 删除 / 去抖自动保存 / 另存到。
import { useCallback, useRef, useState } from "react";
import { archiveDir, isArchivedPath } from "../core/archive";
import {
  BOARD_EXTENSION,
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
import { ARCHIVE_TEXT, BOARD_MISSING_TEXT, BOARD_SLOTS_FULL, slotsRefusal } from "./boardText";
import { sha256Hex } from "../core/sha256";
import { ipc } from "../shell/ipc";
import { ApiError } from "../shell/apiError";
import { logEvent } from "../shell/log";
import { knownImageInfo } from "./context";
import { errorText } from "../core/errors";

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

interface Saver {
  timer: ReturnType<typeof setTimeout> | null;
  /** 串行化同一画板的写入，避免旧写入覆盖新写入。 */
  chain: Promise<void>;
}

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** 编辑环境里随应用状态变化的部分：能力表、网关发现、该画板的锁定集（排队 / 执行 / 限流退避中的任务节点）。 */
export type EnvSource = (key: string) => Pick<EditEnv, "table" | "discovery" | "locked">;

export function useBoardSessions(userRoot: string | null, envSource: EnvSource) {
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
  /** 画板已不存在（另一页面删除或改名）：带版本保存回 board_missing，服务端不会重建它；删除回 404。 */
  const isMissing = (e: unknown) => e instanceof ApiError && (e.code === "board_missing" || (e.status === 404 && e.code === "not_found"));
  /** 画板位满（#89）：服务端的 message 即统一文案。 */
  const isSlotsFull = (e: unknown) => e instanceof ApiError && e.code === BOARD_SLOTS_FULL;
  /** 归档画板（#90）只读：不进画板变更、不撤销、不保存。 */
  const isReadOnly = (path: string) => !!userRootRef.current && isArchivedPath(userRootRef.current, path);

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
        // 归档画板只读（#90）：从不写回，服务端也会拒绝。
        if (!s || s.status !== "ok" || s.conflicted || isReadOnly(s.path)) return;
        try {
          await writeSession(key, s);
        } catch (e) {
          logEvent("board_save_failed", { board_file: basename(s.path), reason: "autosave", message: errorText(e) });
          const saveError = isMissing(e) ? `未能保存：${BOARD_MISSING_TEXT}。本页内容仍在，可先导出画板包再关闭` : `未能保存到 ${s.path}：${errorText(e)}`;
          patch(key, (x) => ({ ...x, saveError, ...(isConflict(e) ? { conflicted: true } : {}), ...(isMissing(e) ? { missing: true } : {}) }));
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
  const userRootRef = useRef(userRoot);
  userRootRef.current = userRoot;
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
      if (!s || s.status !== "ok" || isReadOnly(s.path)) return null;
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
      if (!s || s.status !== "ok" || isReadOnly(s.path)) return;
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

  /** 关闭全部标签页（切换用户数据根时用）；先落盘。 */
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
      if (opened.kind === "ok" && userRootRef.current) {
        try {
          opened.board = await restoreResultLayers({ readFile: ipc.readFileBytes }, userRootRef.current, opened.board);
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
              missing: false,
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

  /**
   * 新建画板并立即落盘占住文件名。画板位满时不建标签页，返回统一文案交给调用方提示（#89）：
   * 先按列表里的画板位判定；两页同时新建抢最后一个位时由服务端拒绝（409 board_slots_full），同样不留标签页。
   */
  const createBoard = useCallback(async (): Promise<string | null> => {
    if (!userRoot) return null;
    // 读不到列表时不拦：服务端仍会检查。
    const slots = await ipc.listBoards().then((l) => l.slots, () => null);
    const refusal = slots && slotsRefusal(slots, 1);
    if (refusal) return refusal;
    const dir = boardsDir(userRoot);
    const onDisk = await ipc.listBoardNames(dir).catch(() => [] as string[]);
    const openHere = sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
    const path = joinPath(dir, uniqueBoardFileName(DEFAULT_BOARD_TITLE, [...onDisk, ...openHere]));
    const board = newBoard();
    const text = serializeBoard(board);
    let version: string | null = null;
    try {
      await ipc.writeBoard(path, text, { createOnly: true });
      version = await sha256Hex(new TextEncoder().encode(text));
    } catch (e) {
      if (isSlotsFull(e)) return errorText(e);
      // 其余失败照旧：标签页留着，由保存流程报错并重试。
    }
    const key = newId();
    setSessions([...sessionsRef.current, { key, path, status: "ok", board, history: emptyHistory(), notice: null, saveError: null, version, conflicted: false, missing: false }]);
    setActiveKey(key);
    if (version === null) await flush(key);
    return null;
  }, [userRoot, flush, setSessions]);

  /** 导入的画板写进用户数据根画板目录：同名沿用 (2) 自动改名、永不覆盖；写好后在新标签页打开。 */
  const addImportedBoard = useCallback(
    async (board: Board): Promise<string> => {
      if (!userRoot) throw new Error("用户数据根未就绪");
      const dir = boardsDir(userRoot);
      const onDisk = await ipc.listBoardNames(dir);
      const openHere = sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
      const path = joinPath(dir, uniqueBoardFileName(board.title, [...onDisk, ...openHere]));
      await ipc.writeBoard(path, serializeBoard(board));
      await openPath(path, true);
      return path;
    },
    [userRoot, openPath],
  );

  const closeBoard = useCallback(
    async (key: string) => {
      const saver = savers.current.get(key);
      if (saver?.timer) await flush(key);
      else if (saver) await saver.chain;
      // 保存失败不能丢改动：标签页留着，修好后重试或先导出画板包。
      const current = sessionsRef.current.find((s) => s.key === key);
      if (current?.status === "ok" && current.saveError) return;
      dropSession(key);
    },
    [flush],
  );

  /** 关掉标签页且不再保存：画板已删除，或用户放弃一块服务端已不存在的画板。 */
  const dropSession = useCallback(
    (key: string) => {
      const saver = savers.current.get(key);
      if (saver?.timer) clearTimeout(saver.timer);
      savers.current.delete(key);
      const list = sessionsRef.current;
      const index = list.findIndex((s) => s.key === key);
      const next = list.filter((s) => s.key !== key);
      setSessions(next);
      setActiveKey((active) => (active === key ? (next[Math.min(index, next.length - 1)]?.key ?? null) : active));
    },
    [setSessions],
  );

  /** 删除本页已打开的画板：先保存未保存的改动，再带最新版本删除（进回收区的是最新内容），成功后关闭标签页。
   *  保存失败或版本已变（另一页面刚改过）时不删除、不关标签页，以错误抛给调用方。 */
  const deleteBoard = useCallback(
    async (key: string) => {
      await flush(key);
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s) return;
      if (s.status === "ok" && s.saveError) throw new Error(`未删除：${s.missing ? BOARD_MISSING_TEXT : s.conflicted ? "画板已在别处修改，请先重新载入" : `未保存的改动没能保存（${s.saveError}）`}`);
      try {
        await ipc.deleteBoard(s.path, s.status === "ok" ? (s.version ?? undefined) : undefined);
      } catch (e) {
        // 已不存在：与保存时同样处理（导出画板包或关闭）；内容已变：等用户重新载入。标签页都不关。
        if (isMissing(e)) patch(key, (x) => ({ ...x, saveError: `${BOARD_MISSING_TEXT}。本页内容仍在，可先导出画板包再关闭`, conflicted: true, missing: true }));
        else if (isConflict(e)) patch(key, (x) => ({ ...x, saveError: `删除失败：${errorText(e)}`, conflicted: true }));
        throw e;
      }
      dropSession(key);
    },
    [flush, patch, dropSession],
  );

  /** 目标目录里不与磁盘上、本页已开的画板重名的路径：文件名沿用原名，重名加 (2)。 */
  const freePathIn = async (dir: string, path: string, title = basename(path).slice(0, -BOARD_EXTENSION.length)) => {
    const onDisk = await ipc.listBoardNames(dir);
    const openHere = sessionsRef.current.filter((x) => samePath(dirname(x.path), dir)).map((x) => basename(x.path));
    return joinPath(dir, uniqueBoardFileName(title, [...onDisk, ...openHere]));
  };

  /** 本页打开的会话换到新位置（归档 / 取消归档后），内容与撤销历史照旧。 */
  const movedTo = (from: string, to: string) => {
    const s = sessionsRef.current.find((x) => samePath(x.path, from));
    if (s) setSessions(sessionsRef.current.map((x) => (x.key === s.key ? { ...x, path: to } : x)));
  };

  /**
   * 归档（#90）：本页开着的先保存再带版本搬，标签页留着、变为只读；失败以错误抛给调用方。
   * 调用方负责先停掉该画板上的任务（结果写不进只读画板）。
   */
  const archiveBoard = useCallback(
    async (path: string) => {
      if (!userRoot) return;
      const key = sessionsRef.current.find((x) => samePath(x.path, path))?.key;
      if (key) await flush(key);
      const s = key ? sessionsRef.current.find((x) => x.key === key) : undefined;
      if (s?.status === "ok" && s.saveError) throw new Error(`未归档：${s.missing ? BOARD_MISSING_TEXT : s.conflicted ? "画板已在别处修改，请先重新载入" : `未保存的改动没能保存（${s.saveError}）`}`);
      const to = await freePathIn(archiveDir(userRoot), path);
      await ipc.archiveBoard(path, to, s?.status === "ok" ? (s.version ?? undefined) : undefined);
      movedTo(path, to);
    },
    [userRoot, flush],
  );

  /** 取消归档：画板位满时返回统一文案（先按列表判定，抢位时由服务端 409 拒绝）；成功为 null。 */
  const unarchiveBoard = useCallback(
    async (path: string): Promise<string | null> => {
      if (!userRoot) return null;
      const slots = await ipc.listBoards().then((l) => l.slots, () => null);
      const refusal = slots && slotsRefusal(slots, 1);
      if (refusal) return refusal;
      const to = await freePathIn(boardsDir(userRoot), path);
      try {
        await ipc.unarchiveBoard(path, to);
      } catch (e) {
        if (isSlotsFull(e)) return errorText(e);
        throw e;
      }
      movedTo(path, to);
      return null;
    },
    [userRoot],
  );

  /** 复制为新画板：归档画板内容只新建写进画板目录并打开，原画板不动；画板位满时返回统一文案，成功为 null。 */
  const copyAsNewBoard = useCallback(
    async (path: string): Promise<string | null> => {
      if (!userRoot) return null;
      const open = sessionsRef.current.find((x) => samePath(x.path, path));
      let board: Board;
      if (open?.status === "ok") board = open.board;
      else {
        const texts = await ipc.readBoard(path);
        const opened = openBoard(texts.main, texts.bak);
        if (opened.kind !== "ok") throw new Error(opened.kind === "newer" ? `画板格式版本 ${opened.version} 高于本应用` : opened.reason);
        board = opened.board;
      }
      const slots = await ipc.listBoards().then((l) => l.slots, () => null);
      const refusal = slots && slotsRefusal(slots, 1);
      if (refusal) return refusal;
      const to = await freePathIn(boardsDir(userRoot), path, board.title);
      try {
        await ipc.writeBoard(to, serializeBoard(board), { createOnly: true });
      } catch (e) {
        if (isSlotsFull(e)) return errorText(e);
        throw e;
      }
      await openPath(to, true);
      return null;
    },
    [userRoot, openPath],
  );

  closeBoardRef.current = closeBoard;

  /** 本页打开该路径画板的标签页 key；没打开为 null。 */
  const keyOf = useCallback((path: string): string | null => sessionsRef.current.find((s) => samePath(s.path, path))?.key ?? null, []);

  /** 改标题：文件名由标题派生，重名加 (2)，连同 .bak 一起改名。 */
  const renameBoard = useCallback(
    async (key: string, rawTitle: string) => {
      const s = sessionsRef.current.find((x) => x.key === key);
      if (!s || s.status !== "ok") return;
      const title = rawTitle.trim() || DEFAULT_BOARD_TITLE;
      if (title === s.board.title) return;
      if (isReadOnly(s.path)) return patch(key, (x) => ({ ...x, notice: ARCHIVE_TEXT.readOnly }));
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
      if (userRootRef.current) opened.board = await restoreResultLayers({ readFile: ipc.readFileBytes }, userRootRef.current, opened.board);
      patch(key, (x) => ({ ...x, board: opened.board, history: emptyHistory(), version: texts.version ?? null, saveError: null, conflicted: false, missing: false, notice: null }));
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
    snapshot: () => ({ sessions: sessionsRef.current, activeKey: activeKeyRef.current }),
  };
}
