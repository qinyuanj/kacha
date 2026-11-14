// 工作台的启动流程判定（#137）：从 src/App.tsx 拆出的纯逻辑，便于单测。
import { errorText } from "../core/errors";
import { effectiveTable, type CapabilityTable } from "../core/capabilities";
import { parseUiState, type UiState } from "../core/uiState";

/** 启动时读到的东西：能力表覆盖、界面状态。 */
export interface StartupReads {
  /** 读能力表覆盖文件原文；读不到时给原因（不致命：用内置能力表）。 */
  capabilityOverride(): Promise<string | null>;
  /** 读界面状态原文；读不到时给 null（不致命：不记更新提示）。 */
  uiState(): Promise<string | null>;
}

/** 启动的结果。 */
export interface StartupResult {
  /** 生效的能力表。 */
  table: CapabilityTable;
  /** 读能力表覆盖文件失败的说明；没有为 null。 */
  tableError: string | null;
  /** 读到的界面状态。 */
  ui: UiState;
  /** 界面状态读失败（不记更新提示，免得吞掉老用户这次的提示）。 */
  uiReadFailed: boolean;
}

/** 启动流程：读能力表覆盖与界面状态；读能力表覆盖失败只降级，读界面状态失败只标记。 */
export async function readStartup(reads: StartupReads): Promise<StartupResult> {
  let tableError: string | null = null;
  const override = await reads.capabilityOverride().catch((e) => {
    tableError = `读取能力表覆盖文件失败：${e}`;
    return null;
  });
  const effective = effectiveTable(override);
  let uiReadFailed = false;
  const raw: string | null = await reads.uiState().catch(() => {
    uiReadFailed = true;
    return null;
  });
  return { table: effective.table, tableError: tableError ?? effective.error, ui: parseUiState(raw), uiReadFailed };
}

/** 恢复标签页的结果。 */
export interface RestoreResult {
  /** 成功打开的画板路径（按界面状态里的顺序）。 */
  opened: string[];
  /** 要提示的失败（找不到画板、读出错）。 */
  notices: string[];
  /** 当前要激活的画板路径；没有为 null。 */
  activate: string | null;
}

/**
 * 恢复标签页：照界面状态里的顺序打开；找不到的记一条提示。
 * 当前画板仍在就激活它，否则激活第一个打开的；一个都没打开时交给调用方新建。
 */
export function restorePlan(ui: UiState, opened: readonly string[], failed: readonly string[] = []): RestoreResult {
  const notices: string[] = [];
  const open = ui.open_boards.filter((p) => {
    if (opened.includes(p)) return true;
    // 打开时抛错的画板（如 layers.json 损坏）已经报了真实原因，不再额外报「找不到」。
    if (!failed.includes(p)) notices.push(`找不到画板文件：${p}`);
    return false;
  });
  const activate = ui.active_board && open.includes(ui.active_board) ? ui.active_board : (open[0] ?? null);
  return { opened: open, notices, activate };
}

/** 启动时对「已更新到新版本」的提示：没有记录代表首次使用，不提示。 */
export function shouldRecordVersion(version: string | undefined, lastSeenVersion: string | undefined, uiReadFailed: boolean): boolean {
  return !!version && lastSeenVersion === undefined && !uiReadFailed;
}

/** 关闭画板前的确认文案：还有排队 / 执行中的任务时二选一。 */
export function stopTasksText(count: number): string {
  return `还有 ${count} 个任务在排队或执行。关闭后不会在后台继续；已在执行的只停止本地等待，网关侧计算可能仍在继续。`;
}

/** 放弃一块服务端已不存在的画板前的确认文案。 */
export const discardMissingText = "服务端已没有这块画板，关闭后本页内容将丢失。需要保留的话请先导出画板包。";

/** 画板列表里打开不存在的画板时的提示。 */
export const boardMissingText = "画板不存在，可能已在别处改名或删除；请刷新列表";

/** 画板列表里打开已被改名的画板时的提示。 */
export const boardRenamedText = "画板不存在，可能已在别处改名；请刷新列表";

/** 错误的一句话说法。 */
export const errorMessage = (e: unknown) => errorText(e);
