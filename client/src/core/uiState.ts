// 界面状态：恢复画板标签页，记住用户上次看过的版本（「已更新」提示条用），以及各画板已提醒到的体量档位。
// 旧桌面版遗留的 window 字段读取时忽略，下次写回即去掉。
import type { SizeTier } from "./boardSize";

export interface UiState {
  open_boards: string[];
  active_board: string | null;
  /** 用户上次确认看过更新说明的版本；旧文件或新用户没有该字段。 */
  last_seen_version?: string;
  /** 画板路径 → 越线提示已提醒到（用户关过）的档位（#87）；跨浏览器生效，回落到线下即清除。 */
  size_notices?: Record<string, SizeTier>;
}

export const DEFAULT_UI_STATE: UiState = { open_boards: [], active_board: null };

const isTier = (v: unknown): v is SizeTier => v === "warn" || v === "alert";

function parseSizeNotices(raw: unknown): Record<string, SizeTier> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, SizeTier] => isTier(e[1])));
}

export function parseUiState(text: string | null): UiState {
  if (text === null) return DEFAULT_UI_STATE;
  try {
    const raw = JSON.parse(text);
    const boardsOk = Array.isArray(raw.open_boards) && raw.open_boards.every((p: unknown) => typeof p === "string");
    if (!boardsOk) return DEFAULT_UI_STATE;
    const open: string[] = raw.open_boards;
    const active = open.includes(raw.active_board) ? raw.active_board : (open[0] ?? null);
    const state: UiState = { open_boards: open, active_board: active };
    if (typeof raw.last_seen_version === "string") state.last_seen_version = raw.last_seen_version;
    const notices = parseSizeNotices(raw.size_notices);
    if (notices) state.size_notices = notices;
    return state;
  } catch {
    return DEFAULT_UI_STATE;
  }
}

export function serializeUiState(state: UiState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
