// 工作台的视图模型与动作处理器（#137）：从 src/App.tsx 拆出的模块级函数。
// App 里只留「把这些函数接到界面上」的转发（转发体里没有分支，复杂度记在这里）。
import type { Board } from "../core/board";
import type { SizeTier } from "../core/boardSize";
import type { Session } from "./useBoardSessions";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { usageNoticeVisible } from "./appUiState";
import { activeSession, archivedPath, boardNoticeText, boardOpenState, boardTitleOf, dismissSizeNotice, enterTidy, failingSessions, historyLabels, packMenuReason, sizeNoticeOf, type FailingSession } from "./appCallbacks";

/** 工作台此刻的样子：所有派生值一次算好。 */
export interface AppView {
  active: Session | undefined;
  openState: "ok" | "none" | "newer" | "corrupt";
  activeArchived: boolean;
  archived: string | null;
  failures: FailingSession[];
  undoLabel: string | null;
  redoLabel: string | null;
  boardNotice: string | null;
  exportDisabled: string | null;
  downloadDisabled: string | null;
  /** 导入画板包的置灰原因（端口说这项能力还没有时非空）。 */
  importDisabled: string | null;
  sizeNotice: { bytes: number; tier: SizeTier; path: string } | null;
  titleOf(key: string): string;
}

/** 工作台此刻的样子。 */
export function appView(input: {
  sessions: readonly Session[];
  activeKey: string | null;
  userRoot: string | null;
  /** 当前画板的体量（保存后去抖取一次；没有为 null）。 */
  activeSize: { path: string; bytes: number; tier: SizeTier | null } | null;
  /** 各画板已提醒到的体量档位。 */
  sizeNotices: Record<string, SizeTier>;
  /** 端口没有画板包导入能力。 */
  packImportOff?: boolean;
}): AppView {
  const active = activeSession(input.sessions, input.activeKey);
  const labels = historyLabels(active);
  const notice = sizeNoticeOf(input.activeSize, input.sizeNotices);
  const archived = archivedPath(active, input.userRoot);
  return {
    active,
    openState: boardOpenState(active, input.userRoot),
    activeArchived: archived !== null,
    archived,
    failures: failingSessions(input.sessions),
    undoLabel: labels.undo,
    redoLabel: labels.redo,
    boardNotice: boardNoticeText(active),
    exportDisabled: packMenuReason(active, "exportPack"),
    downloadDisabled: packMenuReason(active, "downloadResults"),
    importDisabled: input.packImportOff ? "画板包导入" + UNAVAILABLE_TEXT : null,
    sizeNotice: notice?.tier ? { bytes: notice.bytes, tier: notice.tier, path: notice.path } : null,
    titleOf: (key: string) => boardTitleOf(input.sessions, key),
  };
}

/** 当前画板的体量查询参数（没有画板时为 null）。 */
export function sizeQueryOf(session: Session | undefined): { path: string; version: string | null } | null {
  if (session?.status !== "ok") return null;
  return { path: session.path, version: session.version };
}

/** 用量提醒（没到线时为 null）。 */
export function usageNoticeOf(notice: { level: SizeTier; total: number; limit: number } | null, dismissed: SizeTier | null): { level: SizeTier; total: number; limit: number } | null {
  if (!notice) return null;
  return usageNoticeVisible(notice.level, dismissed) ? notice : null;
}

/** 更新提示（已经看过就不提示）。 */
export function updateNoticeOf(ready: boolean, version: string | null | undefined, lastSeenVersion: string | undefined, shouldShow: (version: string, lastSeen: string | undefined) => boolean): string | null {
  if (!ready || !version) return null;
  return shouldShow(version, lastSeenVersion) ? version : null;
}

/** 新建画板：画板位满时提示统一文案（#89）。 */
export function createBoardOrExplain(create: () => Promise<string | null>, toast: (message: string) => void): Promise<void> {
  return create().then((refusal) => {
    if (refusal) toast(refusal);
  });
}

/** 当前画板的内容（没有画板时给占位）。 */
export function canvasBoard(session: Session | undefined, empty: Board): Board {
  return session?.status === "ok" ? session.board : empty;
}

/** 聚焦请求是不是给当前画板的。 */
export function focusFor(focus: { boardKey: string; nodeId: string; nonce: number } | null, session: Session | undefined): { boardKey: string; nodeId: string; nonce: number } | null {
  return focus && session?.key === focus.boardKey ? focus : null;
}

/** 整理模式是不是开着（归档画板只读，不能整理）。 */
export function tidyingFor(tidyKey: string | null, session: Session | undefined, archived: boolean): boolean {
  if (archived) return false;
  return !!session && tidyKey === session.key;
}

/** 整理模式开关后的画板 key（关掉时为 null）。 */
export function tidyKeyAfter(on: boolean, session: Session | undefined): string | null {
  if (!on) return null;
  return session?.status === "ok" ? session.key : null;
}

/** 移出阶段用的画板 key（没有画板时为空）。 */
export function boardKeyOf(session: Session | undefined): string {
  return session?.status === "ok" ? session.key : "";
}

/** 缺省值：没有时给一个。 */
export const orDefault = <T,>(value: T | null | undefined, fallback: T): T => (value === null || value === undefined ? fallback : value);

/** 可选字符串：没有时给空串。 */
export const orEmpty = (value: string | null | undefined): string => orDefault(value, "");

/** 当前画板的锁定集（没有画板时为空集）。 */
export function lockedOf(locked: ReadonlySet<string> | undefined): ReadonlySet<string> {
  return locked ?? new Set<string>();
}

/** 当前画板已经手过的任务（没有画板时为空集）。 */
export function handledOf(handled: ReadonlySet<string> | undefined): ReadonlySet<string> {
  return handled ?? new Set<string>();
}

/** 记录的版本号：没有版本时为 undefined。 */
export const versionOrUndefined = (version: string | null | undefined): string | undefined => orDefault(version, undefined);

/** 记录的版本号：没有版本时给空串（界面上显示用）。 */
export const versionOrEmpty = (version: string | null | undefined): string => orEmpty(version);

/** 设置面板能不能用（设置已载入且有数据根）。 */
export const settingsEnabled = (loaded: boolean, userRoot: string | null): boolean => loaded && !!userRoot;

/** 用量统计要不要开（界面状态就绪且有数据根）。 */
export const usageEnabled = (metadataReady: boolean, userRoot: string | null): boolean => metadataReady && !!userRoot;

/** 画板自己的提示按钮：关掉它。 */
export function dismissBoardNotice(session: Session | undefined, dismiss: (key: string) => void): void {
  if (session?.status !== "ok") return;
  dismiss(session.key);
}

/** 归档画板的取消归档 / 复制。 */
export function archivedAction(archived: string | null, run: (path: string) => Promise<string | null>): void {
  if (!archived) return;
  void run(archived);
}

/** 画板包菜单里点了一项之后该做什么。 */
export { packMenuPick } from "./appCallbacks";

/** 从画板列表打开一块画板：打不开时提示。 */
export { openFromList } from "./appCallbacks";

/** 提示条的动作：整理模式。 */
export function tidyAction(view: AppView, notices: Record<string, SizeTier>, setSizeNotices: (next: Record<string, SizeTier>) => void, setTidyKey: (key: string | null) => void): void {
  const notice = view.sizeNotice;
  if (!notice) return;
  enterTidy(notices, notice.path, notice.tier ?? "warn", view.active, setSizeNotices, setTidyKey);
}

/** 提示条的动作：关闭体量提示。 */
export function dismissSizeAction(view: AppView, notices: Record<string, SizeTier>, setSizeNotices: (next: Record<string, SizeTier>) => void): void {
  const notice = view.sizeNotice;
  if (!notice) return;
  dismissSizeNotice(notices, notice.path, notice.tier ?? "warn", setSizeNotices);
}
