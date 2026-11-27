// 画板包菜单的条目（#127）：按端口的能力开关给出标签与置灰原因。
//
// 桌面壳本切片没有画板包导出：导出标「尚不可用」并置灰，不假装能跑。
// 菜单只按端口声明的能力与画板状态决定可用性。
//
// 导入画板包不需要打开的画板：它的置灰原因只看端口的能力开关，不看画板状态。
import { UNAVAILABLE_TEXT } from "../core/uiText";
import type { ShellPort } from "../shell/port";

/** 菜单里的一项：标签与置灰原因。 */
interface PackMenuEntry {
  label: string;
  disabledReason: string | null;
}

/** 画板的状态：决定导出能不能做（导入不看它）。 */
interface PackBoardState {
  /** 画板打开着（能导出）。 */
  open: boolean;
  /** 画板在但读不懂（status 不是 ok）。 */
  broken: boolean;
}

/** 导入画板包：不需要打开的画板，置灰只看端口的能力开关（导入与导出是两项能力，见 #131）。 */
function packImportEntry(port: ShellPort): PackMenuEntry {
  const off = port.features.packImport === false;
  return {
    label: off ? "导入画板包…（" + UNAVAILABLE_TEXT + "）" : "导入画板包…",
    disabledReason: off ? "画板包导入" + UNAVAILABLE_TEXT : null,
  };
}

/** 要打开画板才能用的条目：端口说还没有这项能力时标「尚不可用」。 */
function needsBoard(available: boolean, offReason: string, label: string, verb: string, board: PackBoardState): PackMenuEntry {
  return {
    label: available ? label : `${label}（${UNAVAILABLE_TEXT}）`,
    disabledReason: available ? (board.open ? null : board.broken ? `画板无法打开，不能${verb}` : "没有打开的画板") : offReason,
  };
}

/** 导出画板包：要有打开的画板；端口说还没有时标「尚不可用」。 */
function packExportEntry(port: ShellPort, board: PackBoardState): PackMenuEntry {
  return needsBoard(port.features.packExport, "画板包导出" + UNAVAILABLE_TEXT, "导出画板包…", "导出", board);
}

/** 画板包菜单的条目（顶部「画板包」菜单）：导入与导出。 */
export function packMenuEntries(port: ShellPort, board: PackBoardState): PackMenuEntry[] {
  return [packImportEntry(port), packExportEntry(port, board)];
}
