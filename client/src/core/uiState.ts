// 界面状态：只恢复画板标签页；旧桌面版遗留的 window 字段读取时忽略，下次写回即去掉。

export interface UiState {
  open_boards: string[];
  active_board: string | null;
}

export const DEFAULT_UI_STATE: UiState = { open_boards: [], active_board: null };

export function parseUiState(text: string | null): UiState {
  if (text === null) return DEFAULT_UI_STATE;
  try {
    const raw = JSON.parse(text);
    const boardsOk = Array.isArray(raw.open_boards) && raw.open_boards.every((p: unknown) => typeof p === "string");
    if (!boardsOk) return DEFAULT_UI_STATE;
    const open: string[] = raw.open_boards;
    const active = open.includes(raw.active_board) ? raw.active_board : (open[0] ?? null);
    return { open_boards: open, active_board: active };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

export function serializeUiState(state: UiState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
