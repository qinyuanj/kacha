// 归档画板（#90，ADR 0019）：放在画板目录下的归档子目录里，只读、不占画板位；画板文件格式不变。
import policy from "../../../contracts/board-policy.json";
import type { BoardAction, MenuItem } from "./contextMenu";
import { boardsDir, dirname, joinPath } from "./paths";

/** TS 与 Rust 同读共享契约。 */
export const ARCHIVE_DIR_NAME = policy.archive_dir;

export const archiveDir = (userRoot: string) => joinPath(boardsDir(userRoot), ARCHIVE_DIR_NAME);

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** 该画板文件在归档子目录里（归档画板只读）。 */
export const isArchivedPath = (userRoot: string, path: string) => norm(dirname(path)) === norm(archiveDir(userRoot));

/** 归档画板上仍可用的动作：放大预览与下载结果（另存为）。 */
const READ_ONLY_ACTIONS: ReadonlySet<BoardAction> = new Set(["preview", "saveAs"]);

export const isReadOnlyAction = (action: BoardAction) => READ_ONLY_ACTIONS.has(action);

/** 归档画板的上下文菜单 / 悬浮动作条：去掉一切编辑类条目，首条不画分隔线。 */
export const readOnlyMenu = (items: MenuItem[]): MenuItem[] =>
  items.filter((i) => isReadOnlyAction(i.action)).map(({ separatorBefore: _, ...i }, n) => (n > 0 && _ ? { ...i, separatorBefore: true } : i));
