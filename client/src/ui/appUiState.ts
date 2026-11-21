// 工作台的界面状态判定（#137）：从 src/App.tsx 拆出的纯逻辑，便于单测。
import { moveSizeNotice, serializeUiState, type UiState } from "../core/uiState";
import { sizeNotice, type SizeTier } from "../core/boardSize";

/** 一次会话快照：写界面状态用。 */
export interface SessionSnapshot {
  sessions: { key: string; path: string }[];
  activeKey: string | null;
}

/** 要写进界面状态的内容：打开的画板、当前画板、上次看过的版本、各画板已提醒到的体量档位。 */
export function uiStateOf(snapshot: SessionSnapshot, lastSeenVersion: string | undefined, sizeNotices: Record<string, SizeTier>): UiState {
  const active = snapshot.sessions.find((s) => s.key === snapshot.activeKey);
  return {
    open_boards: snapshot.sessions.map((s) => s.path),
    active_board: active?.path ?? null,
    last_seen_version: lastSeenVersion,
    size_notices: sizeNotices,
  };
}

/** 界面状态的原文。 */
export const uiStateText = (state: UiState) => serializeUiState(state);

/** 画板改名或搬到归档目录时，提示记录跟随同一块画板。 */
export const noticesAfterMove = (notices: Record<string, SizeTier>, from: string, to: string) => moveSizeNotice(notices, from, to);

/** 当前画板的越线提示该不该显示，以及已提醒到的档位。 */
export function activeSizeNotice(tier: SizeTier | null, notified: SizeTier | undefined): { show: SizeTier | null; notified: SizeTier | undefined } {
  return sizeNotice(tier, notified);
}

/** 用量提醒：本页关掉的档位不再提醒（升到红再提醒）。 */
export function usageNoticeVisible(level: SizeTier | null, dismissed: SizeTier | null): boolean {
  if (!level) return false;
  return !(dismissed === "alert" || dismissed === level);
}

/** 页面级模态开着：粘贴放行给弹窗，不落到背后的画板（#96）。 */
export function modalOpenOf(state: {
  settingsOpen: boolean;
  changelogOpen: boolean;
  boardListOpen: boolean;
  confirmOpen: boolean;
  sendTextOpen: boolean;
  packDialogOpen: boolean;
  feedbackOpen?: boolean;
}): boolean {
  return state.settingsOpen || state.changelogOpen || state.boardListOpen || state.confirmOpen || state.sendTextOpen || state.packDialogOpen || state.feedbackOpen === true;
}

/** 画板包菜单里各条目的禁用原因：导出与下载各说各的。 */
export function packMenuDisabled(active: { status: string } | undefined, action: "exportPack" | "downloadResults"): string | null {
  if (active?.status === "ok") return null;
  if (!active) return "没有打开的画板";
  return action === "exportPack" ? "画板无法打开，不能导出" : "画板无法打开，不能下载";
}

/** 保存失败的画板顶部的说明与按钮：冲突、丢失、其它失败各有各的说法。 */
export function saveFailureNotice(s: { saveError: string; missing: boolean; conflicted: boolean }): { note: string; actions: ("reload" | "retry" | "export" | "close")[] } {
  if (s.missing) return { note: "", actions: ["retry", "export", "close"] };
  if (s.conflicted) return { note: "（改动保留在本页，不会自动合并）", actions: ["reload", "export"] };
  return { note: "（之后每次修改都会重试）", actions: ["retry", "export"] };
}
