// 工作台动作的接线（#137）：模块级函数，各自带判定。
// App 里只留「转发到这些函数」的回调（回调体里没有分支，复杂度记在这些函数上）。
import type { Board } from "../core/board";
import type { BoardChange } from "../core/edit";
import type { RunTarget } from "../core/runner";
import type { Session } from "./useBoardSessions";
import { isArchivedPath } from "../core/archive";
import { redoLabel, undoLabel } from "../core/history";
import { sizeNotice, type SizeTier } from "../core/boardSize";

/** 端口里用到的那些。 */
export interface AppPorts {
  board: { remove(path: string, version?: string): Promise<void> };
  media: { copyText(text: string): Promise<void>; downloadBoardResults(path: string): void };
  ui: { ask(text: string, options?: Record<string, unknown>): Promise<boolean> };
}

/** 多画板会话里用到的那些。 */
export interface AppBoards {
  getBoard(key: string): Board | null;
  boardFileName(key: string): string | null;
  keyOf(path: string): string | null;
  closeBoard(key: string): Promise<void>;
  deleteBoard(key: string): Promise<void>;
  archiveBoard(path: string): Promise<void>;
  unarchiveBoard(path: string): Promise<string | null>;
  copyAsNewBoard(path: string): Promise<string | null>;
  dropSession(key: string): void;
  dismissNotice(key: string): void;
  reload(key: string): Promise<void>;
  retrySave(key: string): Promise<void>;
  openPath(path: string, activate: boolean): Promise<boolean>;
  flushAll(): Promise<void>;
  flushNow(key: string): Promise<void>;
  renameBoard(key: string, title: string): Promise<void>;
  moveOutStage(key: string, stageId: string): Promise<string>;
  setActiveKey(key: string): void;
  snapshot(): { sessions: { key: string; path: string }[]; activeKey: string | null };
}

/** 运行器里用到的那些。 */
export interface AppRunner {
  getSnapshot(): { board(key: string): { locked: ReadonlySet<string>; nodes: ReadonlyMap<string, unknown>; handled: ReadonlySet<string> }; active: readonly { boardKey: string; taskNodeId: string; state: string }[]; pending(key: string): number };
  closeBoard(key: string): void;
  cancel(arg: { kind: "task"; boardKey: string; taskNodeId: string } | { kind: "copy"; taskId: string } | { kind: "waiting" }): void;
  submit(target: RunTarget, board: Board, taskIds: string[], copies: Record<string, number>): Promise<string[]>;
  regenerate(target: RunTarget, board: Board, taskNodeId: string, request: { kind: "regenerate"; copies: number } | { kind: "variant"; fromTaskId: string }): Promise<string | null>;
}

/** 当前画板的会话：没有打开的画板时为 undefined。 */
export function activeSession(sessions: readonly Session[], activeKey: string | null): Session | undefined {
  return sessions.find((s) => s.key === activeKey);
}

/** 当前画板能不能打开（ok 状态才进画布）。 */
export function openableBoard(session: Session | undefined): Board | null {
  return session?.status === "ok" ? session.board : null;
}

/** 保存失败的画板（要提示的那几块）。 */
export interface FailingSession {
  key: string;
  board: Board;
  saveError: string;
  missing: boolean;
  conflicted: boolean;
}

/** 哪些画板保存失败了（只有 ok 状态才看得到）。 */
export function failingSessions(sessions: readonly Session[]): FailingSession[] {
  const failing: FailingSession[] = [];
  for (const s of sessions) {
    if (s.status !== "ok" || !s.saveError) continue;
    failing.push({ key: s.key, board: s.board, saveError: s.saveError, missing: s.missing, conflicted: s.conflicted });
  }
  return failing;
}

/** 画板能不能打开（打不开的给「无法打开 / 版本太新 / 损坏」三种说明）。 */
export type BoardOpenState = "ok" | "none" | "newer" | "corrupt";

/** 当前画板的状态：工作区据此给哪一块内容。 */
export function boardOpenState(session: Session | undefined, userRoot: string | null): BoardOpenState {
  if (!session || !userRoot) return "none";
  if (session.status === "newer") return "newer";
  if (session.status === "corrupt") return "corrupt";
  return "ok";
}

/** 归档画板只读：能看、能放大、能下载结果与导出画板包。 */
export function archivedPath(session: Session | undefined, userRoot: string | null): string | null {
  if (session?.status !== "ok" || !userRoot) return null;
  return isArchivedPath(userRoot, session.path) ? session.path : null;
}

/** 画板包菜单的禁用原因：导出与下载各说各的。 */
export function packMenuReason(session: Session | undefined, action: "exportPack" | "downloadResults"): string | null {
  if (session?.status === "ok") return null;
  if (!session) return "没有打开的画板";
  return action === "exportPack" ? "画板无法打开，不能导出" : "画板无法打开，不能下载";
}

/** 画板变更的接线：提交与结果立即落盘（避免关页时丢）。 */
export function applyWithFlush(apply: (key: string, change: BoardChange) => unknown, flushNow: (key: string) => Promise<void>, key: string, change: BoardChange): unknown {
  const result = apply(key, change);
  if (result && (change.kind === "submitted" || change.kind === "runResult")) void flushNow(key);
  return result;
}

/** 当前画板的变更入口：没有打开的画板时什么也不做。 */
export function applyActive(apply: (key: string, change: BoardChange) => unknown, activeKey: string | null, change: BoardChange): unknown {
  return activeKey ? apply(activeKey, change) : null;
}

/** 当前画板的试算：没有打开的画板时什么也不做。 */
export function checkActive(check: (key: string, change: BoardChange) => unknown, activeKey: string | null, change: BoardChange): unknown {
  return activeKey ? check(activeKey, change) : null;
}

/** 撤销 / 重做（按标签页）：没有打开的画板时什么也不做。 */
export const undoOn = (undoBoard: (key: string) => void, activeKey: string | null) => (activeKey ? undoBoard(activeKey) : undefined);
export const redoOn = (redoBoard: (key: string) => void, activeKey: string | null) => (activeKey ? redoBoard(activeKey) : undefined);

/** 任务节点的取消：没有打开的画板时什么也不做。 */
export const cancelTaskOn = (runner: AppRunner, activeKey: string | null, taskNodeId: string) =>
  activeKey ? runner.cancel({ kind: "task", boardKey: activeKey, taskNodeId }) : undefined;

/** 标签页激活：同时把焦点请求清掉（换画板时不该还盯着旧画板的节点）。 */
export function activateBoard(setActiveKey: (key: string) => void, clearFocus: () => void, key: string): void {
  clearFocus();
  setActiveKey(key);
}

/** 画板包菜单的开关：开着就关掉，关着就开在给的位置。 */
export function togglePackMenu(current: { x: number; y: number } | null, at: { x: number; y: number }): { x: number; y: number } | null {
  return current ? null : at;
}

/** 画板列表关掉时：连同「管理画板」入口一起复位。 */
export function closeBoardList(setBoardListOpen: (open: boolean) => void, setManageBoards: (manage: boolean) => void): void {
  setBoardListOpen(false);
  setManageBoards(false);
}

/** 用量提醒的入口：先落盘再打开画板列表。 */
export function openManageBoards(flushAll: () => Promise<void>, setManageBoards: (manage: boolean) => void, setBoardListOpen: (open: boolean) => void): void {
  void flushAll().then(() => {
    setManageBoards(true);
    setBoardListOpen(true);
  });
}

/** 进入整理模式：即算用户已看到这条提醒。 */
export function enterTidy(notices: Record<string, SizeTier>, path: string, tier: SizeTier, session: Session | undefined, setSizeNotices: (next: Record<string, SizeTier>) => void, setTidyKey: (key: string | null) => void): void {
  setSizeNotices({ ...notices, [path]: tier });
  if (session?.status === "ok") setTidyKey(session.key);
}

/** 关闭体量提示：同样把档位记下（不再提醒）。 */
export function dismissSizeNotice(notices: Record<string, SizeTier>, path: string, tier: SizeTier, setSizeNotices: (next: Record<string, SizeTier>) => void): void {
  setSizeNotices({ ...notices, [path]: tier });
}

/** 当前画板的体量提示：该显示哪一档，以及已提醒到哪一档。 */
export interface SizeNoticeView {
  path: string;
  bytes: number;
  /** 该显示的档位（null = 不显示）。 */
  tier: SizeTier | null;
  /** 已提醒到的档位。 */
  notified: SizeTier | undefined;
}

/** 当前画板的体量提示：按体量分档，按已提醒的档位决定要不要再提醒。 */
export function sizeNoticeOf(size: { path: string; bytes: number; tier: SizeTier | null } | null, notices: Record<string, SizeTier>): SizeNoticeView | null {
  if (!size) return null;
  const noticed = sizeNotice(size.tier, notices[size.path]);
  return { path: size.path, bytes: size.bytes, tier: noticed.show, notified: noticed.notified };
}

/** 体量回落时校正已提醒档位（清除回落那条线的记录）。 */
export function sizeNoticeUpdated(notices: Record<string, SizeTier>, notice: { path: string; tier: SizeTier | null } | null): Record<string, SizeTier> {
  if (!notice || !notice.tier) return notices;
  if (notice.tier === notices[notice.path]) return notices;
  const { [notice.path]: _dropped, ...rest } = notices;
  return { ...rest, [notice.path]: notice.tier };
}

/** 当前画板自己的提示（重命名失败、重新载入失败等）。 */
export function boardNoticeText(session: Session | undefined): string | null {
  return session?.status === "ok" ? session.notice : null;
}

/** 画板文件名（只用于日志）。 */
export function boardFileOf(session: Session | undefined): string {
  return session ? session.path.slice(session.path.lastIndexOf("/") + 1) : "";
}

/** 运行指示里的画板名：已关闭的画板给个说明。 */
export function boardTitleOf(sessions: readonly Session[], key: string): string {
  const s = sessions.find((x) => x.key === key);
  return s?.status === "ok" ? s.board.title : "（已关闭的画板）";
}

/** 跳到某个任务的节点：切画板并记下聚焦请求。 */
export function jumpToTask(setActiveKey: (key: string) => void, setFocus: (next: { boardKey: string; nodeId: string; nonce: number }) => void, current: { boardKey: string; nodeId: string; nonce: number } | null, task: { boardKey: string; taskNodeId: string }): void {
  setActiveKey(task.boardKey);
  setFocus({ boardKey: task.boardKey, nodeId: task.taskNodeId, nonce: (current?.nonce ?? 0) + 1 });
}

/** 画板包菜单里点了一项之后该做什么。 */
export function packMenuPick(action: "importPack" | "exportPack" | "downloadResults", session: Session | undefined, importPack: () => void, prepareExport: (key: string) => void, download: (path: string) => void): void {
  if (action === "importPack") return void importPack();
  if (session?.status !== "ok") return;
  if (action === "exportPack") return void prepareExport(session.key);
  void download(session.path);
}

/** 画板列表里打开一块画板：打不开时提示。 */
export function openFromList(open: (path: string, activate: boolean) => Promise<boolean>, toast: (message: string) => void, path: string): void {
  void open(path, true).then((opened) => {
    if (!opened) toast("画板不存在，可能已在别处改名；请刷新列表");
  });
}

/** 当前画板的撤销 / 重做标签。 */
export function historyLabels(session: Session | undefined): { undo: string | null; redo: string | null } {
  if (session?.status !== "ok") return { undo: null, redo: null };
  return { undo: undoLabel(session.history), redo: redoLabel(session.history) };
}
