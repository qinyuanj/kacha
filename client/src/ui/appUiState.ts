// 工作台的界面状态判定（#137）：从 src/App.tsx 拆出的纯逻辑，便于单测。
import { serializeUiState, type UiState } from "../core/uiState";
import type { SizeTier } from "../core/boardSize";

/** 一次会话快照：写界面状态用。 */
export interface SessionSnapshot {
  sessions: { key: string; path: string }[];
  activeKey: string | null;
}

/** 要写进界面状态的内容：打开的画板、当前画板、上次看过的版本。 */
export function uiStateOf(snapshot: SessionSnapshot, lastSeenVersion: string | undefined): UiState {
  const active = snapshot.sessions.find((s) => s.key === snapshot.activeKey);
  return {
    open_boards: snapshot.sessions.map((s) => s.path),
    active_board: active?.path ?? null,
    last_seen_version: lastSeenVersion,
  };
}

/** 界面状态的原文。 */
export const uiStateText = (state: UiState) => serializeUiState(state);

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
