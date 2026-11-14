// 画板包菜单的条目（#127）：按端口的能力开关给出标签与置灰原因。
//
// 桌面壳本切片没有画板包导出与生成：这些入口标「尚不可用」并置灰，不假装能跑。
// Web 版三项都在，标签与置灰原因照旧。
//
// 导入画板包不需要打开的画板：它的置灰原因只看端口的能力开关，不看画板状态。
import type { ShellPort } from "../shell/port";

/** 菜单里的一项：标签与置灰原因。 */
export interface PackMenuEntry {
  label: string;
  disabledReason: string | null;
}

/** 画板的状态：决定导出与下载能不能做（导入不看它）。 */
export interface PackBoardState {
  /** 画板打开着（能导出、能下载）。 */
  open: boolean;
  /** 画板在但读不懂（status 不是 ok）。 */
  broken: boolean;
}

/** 导入画板包：不需要打开的画板，置灰只看端口的能力开关（导入与导出是两项能力，见 #131）。 */
export function packImportEntry(port: ShellPort): PackMenuEntry {
  const off = port.features.packImport === false;
  return {
    label: off ? "导入画板包…（尚不可用）" : "导入画板包…",
    disabledReason: off ? "画板包导入尚不可用" : null,
  };
}

/** 导出画板包：要有打开的画板；端口说还没有时标「尚不可用」。 */
export function packExportEntry(port: ShellPort, board: PackBoardState): PackMenuEntry {
  const off = !port.features.packExport;
  return {
    label: off ? "导出画板包…（尚不可用）" : "导出画板包…",
    disabledReason: off ? "画板包导出尚不可用" : board.open ? null : board.broken ? "画板无法打开，不能导出" : "没有打开的画板",
  };
}

/** 下载整板结果：要画板打开着；没有生成时标「尚不可用」。 */
export function packDownloadEntry(port: ShellPort, board: PackBoardState): PackMenuEntry {
  const off = !port.features.generation;
  return {
    label: off ? "下载整板结果（zip）（尚不可用）" : "下载整板结果（zip）",
    disabledReason: off ? "生成尚不可用，没有结果可下载" : board.open ? null : board.broken ? "画板无法打开，不能下载" : "没有打开的画板",
  };
}

/** 画板包菜单的条目（顶部「画板包」菜单）：导入、导出、下载整板结果。 */
export function packMenuEntries(port: ShellPort, board: PackBoardState): PackMenuEntry[] {
  return [packImportEntry(port), packExportEntry(port, board), packDownloadEntry(port, board)];
}
