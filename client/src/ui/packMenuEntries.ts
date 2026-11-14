// 画板包菜单的条目（#127）：按端口的能力开关给出标签与置灰原因。
//
// 桌面壳本切片没有画板包导出与生成：这些入口标「尚不可用」并置灰，不假装能跑。
// Web 版三项都在，标签与置灰原因照旧。
import type { ShellPort } from "../shell/port";

/** 菜单里的一项：标签与置灰原因。 */
export interface PackMenuEntry {
  label: string;
  disabledReason: string | null;
}

/** 画板包菜单的条目：按端口的能力开关给出标签与置灰原因。 */
export function packMenuEntries(port: ShellPort, boardOpen: boolean): PackMenuEntry[] {
  const packExportOff = !port.features.packExport;
  const generationOff = !port.features.generation;
  const noBoard = boardOpen ? null : "没有打开的画板";
  return [
    {
      label: packExportOff ? "导入画板包…（尚不可用）" : "导入画板包…",
      disabledReason: packExportOff ? "画板包导出尚不可用" : null,
    },
    {
      label: packExportOff ? "导出画板包…（尚不可用）" : "导出画板包…",
      disabledReason: packExportOff ? "画板包导出尚不可用" : noBoard,
    },
    {
      label: generationOff ? "下载整板结果（zip）（尚不可用）" : "下载整板结果（zip）",
      disabledReason: generationOff ? "生成尚不可用，没有结果可下载" : noBoard,
    },
  ];
}
