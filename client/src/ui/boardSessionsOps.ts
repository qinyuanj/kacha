// 多画板会话的各个操作（#137）：从 ui/useBoardSessions.ts 拆出的模块级函数。
// crapper 按函数各自计复杂度：操作都放这里，hook 里就只剩接线。
import { finishMoveOut as finishMoveOutTo, writeMovedOut as writeMovedOutTo } from "./boardSessionsMoveOut";
import { archiveDir } from "../core/archive";
import { BOARD_EXTENSION, DEFAULT_BOARD_TITLE, newBoard, openBoard, serializeBoard, uniqueBoardFileName, type Board } from "../core/board";
import { editBoard, type BoardChange, type EditEnv, type EditResult } from "../core/edit";
import { newId } from "../core/ids";
import { emptyHistory, recordChange, type History } from "../core/history";
import { basename, boardsDir, dirname, joinPath, resolveFromRoot } from "../core/paths";
import { restoreResultLayers } from "../core/taskDir";
import { prepareStageSplit } from "../core/moveOut";
import { slotsRefusal, TIDY_TEXT } from "./boardText";
import { sha256Hex } from "../core/sha256";
import { errorText } from "../core/errors";
import { deleteBlockedText, archiveBlockedText, deleteFailureState, isSlotsFull, moveOutBlockedText, samePath } from "./boardSessions";
import type { Session, OkSession } from "./useBoardSessions";

/** 端口里用到的那些（这里只列用到的，好让各个操作自己接）。 */
export interface SessionPorts {
  board: {
    read(path: string): Promise<{ main: string | null; bak: string | null; version: string | null }>;
    write(path: string, text: string, options?: { version?: string; createOnly?: boolean }): Promise<void>;
    rename(from: string, to: string, version?: string): Promise<void>;
    remove(path: string, version?: string): Promise<void>;
    archive(from: string, to: string, version?: string): Promise<void>;
    unarchive(from: string, to: string): Promise<void>;
    listNames(dir: string): Promise<string[]>;
    list(): Promise<{ slots: { used: number; total: number } }>;
  };
  files: { readFile(path: string): Promise<Uint8Array>; sha256(path: string): Promise<string> };
  ui: { log(kind: string, fields: Record<string, unknown>): void };
}

/** 会话状态的读写。 */
export interface SessionStore {
  sessionsRef: { current: Session[] };
  setSessions(next: Session[]): void;
  patch(key: string, fn: (s: OkSession) => OkSession): void;
  sessionOf(key: string): Session | undefined;
}

/** 打开一块画板的结果。 */
export interface OpenResult {
  /** 打开成功（主文件或 .bak 至少有一个）。 */
  opened: boolean;
  /** 新建的会话（新建时才有）。 */
  session?: Session;
}

/** 会话是否可编辑（ok 状态且不在归档目录、也没在搬动中）。 */
export function editable(session: Session | undefined, readOnlyPath: (path: string) => boolean, moving: ReadonlySet<string>): boolean {
  if (!session || session.status !== "ok") return false;
  if (readOnlyPath(session.path)) return false;
  return !moving.has(session.key);
}

/** 画板写入的唯一入口：算出新画板，落撤销步，排程去抖保存。会话不可编辑时为 null。 */
export function applyChange(
  store: SessionStore,
  env: EditEnv,
  scheduleSave: (key: string) => void,
  readOnlyPath: (path: string) => boolean,
  moving: ReadonlySet<string>,
  key: string,
  change: BoardChange,
): EditResult | null {
  const session = store.sessionOf(key);
  if (!editable(session, readOnlyPath, moving)) return null;
  const current = session as OkSession;
  const result = editBoard(current.board, change, env);
  if (result.board === current.board) return result;
  store.patch(key, (x) => ({ ...x, board: result.board, history: result.step ? recordChange(x.history, current.board, result.step, Date.now()) : x.history }));
  scheduleSave(key);
  return result;
}

/** 按当前画板试算一次变更，不写入；会话不可编辑时为 null。 */
export function checkChange(store: SessionStore, env: EditEnv, key: string, change: BoardChange): EditResult | null {
  const session = store.sessionOf(key);
  return session?.status === "ok" ? editBoard(session.board, change, env) : null;
}

/** 撤销 / 重做一步。 */
export function travelHistory(
  store: SessionStore,
  direction: (history: History, board: Board, locked: ReadonlySet<string>) => { board: Board; history: History } | null,
  locked: ReadonlySet<string>,
  scheduleSave: (key: string) => void,
  readOnlyPath: (path: string) => boolean,
  moving: ReadonlySet<string>,
  key: string,
): void {
  const session = store.sessionOf(key);
  if (!editable(session, readOnlyPath, moving)) return;
  const current = session as OkSession;
  const result = direction(current.history, current.board, locked);
  if (!result) return;
  store.patch(key, (x) => ({ ...x, board: result.board, history: result.history }));
  scheduleSave(key);
}

/** 打开画板文件：已打开则切过去。主文件与 .bak 都不存在时返回 false。 */
export async function openBoardPath(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string | null,
  activate: boolean,
  setActiveKey: (key: string) => void,
  path: string,
): Promise<boolean> {
  const existing = store.sessionsRef.current.find((s) => samePath(s.path, path));
  if (existing) {
    if (activate) setActiveKey(existing.key);
    return true;
  }
  const texts = await ports.board.read(path);
  if (texts.main === null && texts.bak === null) return false;
  const opened = openBoard(texts.main, texts.bak);
  const board = await restoreLayers(ports, userRoot, opened);
  const key = newId();
  const session = sessionOf(texts, opened, key, path, board);
  store.setSessions([...store.sessionsRef.current, session]);
  if (activate) setActiveKey(key);
  return true;
}

/** 任务目录是真源：Flash 结果的图层身份 / 定位按 layers.json 还原（画板只冗余展示）。 */
async function restoreLayers(ports: SessionPorts, userRoot: string | null, opened: ReturnType<typeof openBoard>): Promise<Board> {
  if (opened.kind !== "ok" || !userRoot) return opened.kind === "ok" ? opened.board : ({} as Board);
  try {
    opened.board = await restoreResultLayers({ readFile: ports.files.readFile }, userRoot, opened.board);
  } catch (e) {
    throw new Error(`打开画板失败：${errorText(e)}`);
  }
  return opened.board;
}

/** 打开后的会话。 */
function sessionOf(
  texts: { main: string | null; bak: string | null; version: string | null },
  opened: ReturnType<typeof openBoard>,
  key: string,
  path: string,
  board: Board,
): Session {
  if (opened.kind === "newer") return { key, path, status: "newer", version: opened.version };
  if (opened.kind === "corrupt") return { key, path, status: "corrupt", reason: opened.reason };
  return {
    key,
    path,
    status: "ok",
    board,
    history: emptyHistory(),
    notice: opened.recoveredFromBak ? "画板主文件已损坏，已从备份 .bak 恢复；下次保存会写回主文件。" : null,
    saveError: null,
    version: texts.version ?? null,
    conflicted: false,
    missing: false,
  };
}

/** 新建画板并立即落盘占住文件名。画板位满时返回统一文案（#89）。 */
export async function createBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string | null,
  flush: (key: string) => Promise<void>,
  setActiveKey: (key: string) => void,
): Promise<string | null> {
  if (!userRoot) return null;
  // 读不到列表时不拦：服务端仍会检查。
  const slots = await ports.board.list().then((l) => l.slots, () => null);
  const refusal = slots ? slotsRefusal(slots, 1) : null;
  if (refusal) return refusal;
  const dir = boardsDir(userRoot);
  const onDisk = await ports.board.listNames(dir).catch(() => [] as string[]);
  const openHere = store.sessionsRef.current.filter((s) => samePath(dirname(s.path), dir)).map((s) => basename(s.path));
  const path = joinPath(dir, uniqueBoardFileName(DEFAULT_BOARD_TITLE, [...onDisk, ...openHere]));
  const board = newBoard();
  const text = serializeBoard(board);
  let version: string | null = null;
  try {
    await ports.board.write(path, text, { createOnly: true });
    version = await sha256Hex(new TextEncoder().encode(text));
  } catch (e) {
    if (isSlotsFull(e)) return errorText(e);
    // 其余失败照旧：标签页留着，由保存流程报错并重试。
  }
  const key = newId();
  store.setSessions([...store.sessionsRef.current, { key, path, status: "ok", board, history: emptyHistory(), notice: null, saveError: null, version, conflicted: false, missing: false }]);
  setActiveKey(key);
  if (version === null) await flush(key);
  return null;
}

/** 目标目录里不与磁盘上、本页已开的画板重名的路径：文件名沿用原名，重名加 (2)。 */
export async function freePathIn(store: SessionStore, ports: SessionPorts, dir: string, path: string, title?: string): Promise<string> {
  const onDisk = await ports.board.listNames(dir);
  const openHere = store.sessionsRef.current.filter((x) => samePath(dirname(x.path), dir)).map((x) => basename(x.path));
  const stem = title ?? basename(path).slice(0, -BOARD_EXTENSION.length);
  return joinPath(dir, uniqueBoardFileName(stem, [...onDisk, ...openHere]));
}

/** 删除本页已打开的画板：先保存未保存的改动，再带最新版本删除。 */
export async function deleteBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  flush: (key: string) => Promise<void>,
  dropSession: (key: string) => void,
  key: string,
): Promise<void> {
  await flush(key);
  const session = store.sessionOf(key);
  if (!session) return;
  if (session.status === "ok" && session.saveError) throw new Error(deleteBlockedText({ missing: session.missing, conflicted: session.conflicted, saveError: session.saveError }));
  try {
    await ports.board.remove(session.path, session.status === "ok" ? (session.version ?? undefined) : undefined);
  } catch (e) {
    // 已不存在：与保存时同样处理（导出画板包或关闭）；内容已变：等用户重新载入。标签页都不关。
    const state = deleteFailureState(e);
    if (state.saveError) store.patch(key, (x) => ({ ...x, ...state }));
    throw e;
  }
  dropSession(key);
}

/**
 * 归档：先保存再带版本搬，标签页留着、变为只读。
 * 调用方负责先停掉该画板上的任务（结果写不进只读画板）。
 */
export async function archiveBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string | null,
  flush: (key: string) => Promise<void>,
  moving: Set<string>,
  movedTo: (from: string, to: string) => void,
  path: string,
): Promise<void> {
  if (!userRoot) return;
  const key = store.sessionsRef.current.find((x) => samePath(x.path, path))?.key;
  if (key && moving.has(key)) return;
  if (key) moving.add(key);
  try {
    if (key) await flush(key);
    await archiveMove(store, ports, userRoot, movedTo, path, key);
  } finally {
    if (key) moving.delete(key);
  }
}

/** 归档的搬移那一步：查目标名、搬文件、通知调用方。 */
async function archiveMove(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string,
  movedTo: (from: string, to: string) => void,
  path: string,
  key: string | undefined,
): Promise<void> {
  const session = key ? store.sessionOf(key) : undefined;
  if (session?.status === "ok" && session.saveError) throw new Error(archiveBlockedText({ missing: session.missing, conflicted: session.conflicted, saveError: session.saveError }));
  const to = await freePathIn(store, ports, archiveDir(userRoot), path);
  await ports.board.archive(path, to, session?.status === "ok" ? (session.version ?? undefined) : undefined);
  movedTo(path, to);
}

/** 取消归档：画板位满时返回统一文案（先按列表判定，抢位时由服务端 409 拒绝）；成功为 null。 */
export async function unarchiveBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string | null,
  movedTo: (from: string, to: string) => void,
  path: string,
): Promise<string | null> {
  if (!userRoot) return null;
  const slots = await ports.board.list().then((l) => l.slots, () => null);
  const refusal = slots ? slotsRefusal(slots, 1) : null;
  if (refusal) return refusal;
  const to = await freePathIn(store, ports, boardsDir(userRoot), path);
  try {
    await ports.board.unarchive(path, to);
  } catch (e) {
    if (isSlotsFull(e)) return errorText(e);
    throw e;
  }
  movedTo(path, to);
  return null;
}

/** 复制为新画板：归档画板内容只新建写进画板目录并打开，原画板不动。 */
export async function copyAsNewBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string | null,
  openPath: (path: string, activate: boolean) => Promise<boolean>,
  path: string,
): Promise<string | null> {
  if (!userRoot) return null;
  const board = await boardForCopy(store, ports, path);
  const slots = await ports.board.list().then((l) => l.slots, () => null);
  const refusal = slots ? slotsRefusal(slots, 1) : null;
  if (refusal) return refusal;
  const to = await freePathIn(store, ports, boardsDir(userRoot), path, board.title);
  try {
    await ports.board.write(to, serializeBoard(board), { createOnly: true });
  } catch (e) {
    if (isSlotsFull(e)) return errorText(e);
    throw e;
  }
  await openPath(to, true);
  return null;
}

/** 要复制的画板内容：本页开着就用内存里的，否则读文件。 */
async function boardForCopy(store: SessionStore, ports: SessionPorts, path: string): Promise<Board> {
  const open = store.sessionsRef.current.find((x) => samePath(x.path, path));
  if (open?.status === "ok") return open.board;
  const texts = await ports.board.read(path);
  const opened = openBoard(texts.main, texts.bak);
  if (opened.kind !== "ok") throw new Error(opened.kind === "newer" ? `画板格式版本 ${opened.version} 高于本应用` : opened.reason);
  return opened.board;
}

/** 改标题：文件名由标题派生，重名加 (2)，连同 .bak 一起改名。 */
export async function renameBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  flush: (key: string) => Promise<void>,
  apply: (key: string, change: BoardChange) => EditResult | null,
  movedTo: (from: string, to: string) => void,
  readOnlyPath: (path: string) => boolean,
  moving: ReadonlySet<string>,
  key: string,
  rawTitle: string,
): Promise<void> {
  const session = store.sessionOf(key);
  if (!session || session.status !== "ok" || moving.has(key)) return;
  const title = rawTitle.trim() || DEFAULT_BOARD_TITLE;
  if (title === session.board.title) return;
  if (readOnlyPath(session.path)) return store.patch(key, (x) => ({ ...x, notice: moveOutBlockedText("readOnly") }));
  // 先落盘挂起的修改，避免去抖写入在改名途中把旧文件重新写出来。
  await flush(key);
  const nextPath = await renamedPath(store, ports, session.path, title, key);
  try {
    if (nextPath !== session.path) await ports.board.rename(session.path, nextPath, session.version ?? undefined);
  } catch (e) {
    store.patch(key, (x) => ({ ...x, notice: `重命名失败：${errorText(e)}` }));
    return;
  }
  movedTo(session.path, nextPath);
  apply(key, { kind: "title", title });
  await flush(key);
}

/** 改名后的路径：文件名由标题派生，重名加 (2)。 */
export async function renamedPath(store: SessionStore, ports: SessionPorts, path: string, title: string, key: string): Promise<string> {
  const dir = dirname(path);
  const self = basename(path);
  const onDisk = await ports.board.listNames(dir).catch(() => [] as string[]);
  const openHere = store.sessionsRef.current.filter((x) => x.key !== key && samePath(dirname(x.path), dir)).map((x) => basename(x.path));
  return joinPath(dir, uniqueBoardFileName(title, [...onDisk, ...openHere], self));
}

/** 冲突后由用户显式重新载入服务端的画板；本页未保存的改动随之放弃（不做自动合并）。 */
export async function reloadBoardSession(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string | null,
  moving: ReadonlySet<string>,
  key: string,
): Promise<void> {
  const session = store.sessionOf(key);
  if (!session || session.status !== "ok") return;
  try {
    const texts = await ports.board.read(session.path);
    const opened = openBoard(texts.main, texts.bak);
    if (opened.kind !== "ok") {
      store.patch(key, (x) => ({ ...x, notice: `重新载入失败：${opened.kind === "newer" ? `画板格式版本 ${opened.version} 高于本应用` : opened.reason}` }));
      return;
    }
    if (userRoot) opened.board = await restoreResultLayers({ readFile: ports.files.readFile }, userRoot, opened.board);
    if (moving.has(key)) return;
    store.patch(key, (x) => ({ ...x, board: opened.board, history: emptyHistory(), version: texts.version ?? null, saveError: null, conflicted: false, missing: false, notice: null }));
  } catch (e) {
    store.patch(key, (x) => ({ ...x, notice: `重新载入失败：${errorText(e)}` }));
  }
}

/**
 * 移出为新画板（#93）：先试算（运行中的任务锁定时拒绝）、查画板位，读阶段外上游结果图的 sha256，
 * 按最新画板拆出新画板只新建不覆盖地写好，最后才在原画板删去这些节点。
 * 任何一步被拒都不改原画板、不写文件。返回要提示的话。
 */
export async function moveOutStageSession(
  store: SessionStore,
  ports: SessionPorts,
  env: EditEnv,
  userRoot: string | null,
  readOnlyPath: (path: string) => boolean,
  moving: ReadonlySet<string>,
  movingOut: { current: boolean },
  apply: (key: string, change: BoardChange) => EditResult | null,
  key: string,
  stageId: string,
): Promise<string> {
  const boardOf = () => {
    const session = store.sessionOf(key);
    return session?.status === "ok" ? session.board : null;
  };
  const tryRemove = () => {
    const board = boardOf();
    return board ? editBoard(board, { kind: "moveOutStage", stageId }, env) : null;
  };
  const blocked = moveOutBlockedReason(store, userRoot, readOnlyPath, moving, movingOut, key, tryRemove);
  if (blocked) return blocked;
  movingOut.current = true;
  try {
    return await moveOutWrite(store, ports, userRoot!, boardOf, tryRemove, stageId, apply, key);
  } catch (e) {
    return TIDY_TEXT.moveOutFailed(errorText(e));
  } finally {
    movingOut.current = false;
  }
}

/** 移出前的各种拦：只读 / 搬不动 / 阶段没了 / 另一个移出在跑。 */
function moveOutBlockedReason(
  store: SessionStore,
  userRoot: string | null,
  readOnlyPath: (path: string) => boolean,
  moving: ReadonlySet<string>,
  movingOut: { current: boolean },
  key: string,
  tryRemove: () => EditResult | null,
): string | null {
  const session = store.sessionOf(key);
  if (session && (readOnlyPath(session.path) || moving.has(key))) return moveOutBlockedText("readOnly");
  const dry = tryRemove();
  if (!userRoot || !dry) return moveOutBlockedText("notEditable");
  if (!dry.step) return moveOutBlockedText("stageGone", dry.hint);
  if (movingOut.current) return moveOutBlockedText("busy");
  return null;
}

/** 移出：查画板位、拆出新画板并写好，最后才在原画板删去这些节点。 */
async function moveOutWrite(
  store: SessionStore,
  ports: SessionPorts,
  userRoot: string,
  boardOf: () => Board | null,
  tryRemove: () => EditResult | null,
  stageId: string,
  apply: (key: string, change: BoardChange) => EditResult | null,
  key: string,
): Promise<string> {
  // 读不到列表时不拦：服务端新建时仍会检查。
  const refusal = await moveOutRefusal(ports);
  if (refusal) return refusal;
  const prepared = await prepareStageSplit(boardOf, stageId, (path) => ports.files.sha256(resolveFromRoot(userRoot, path)), newId);
  const check = tryRemove();
  if (!prepared || !check?.step) return moveOutBlockedText("stageGone", check?.hint);
  const { source: latest, board: fresh } = prepared;
  const path = await freePathIn(store, ports, boardsDir(userRoot), "", fresh.title);
  if (boardOf() !== latest) return TIDY_TEXT.moveOutFailed("移出期间本画板有了新的改动，请重试");
  const written = await writeMovedOutTo(ports, path, fresh);
  if (written) return written;
  return finishMoveOutTo(boardOf, apply, key, stageId, fresh, latest);
}

/** 移出前的画板位预检：读不到列表时不拦（服务端新建时仍会检查）。 */
async function moveOutRefusal(ports: SessionPorts): Promise<string | null> {
  const slots = await ports.board.list().then((l) => l.slots, () => null);
  return slots ? slotsRefusal(slots, 1) : null;
}