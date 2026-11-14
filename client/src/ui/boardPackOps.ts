// 画板包界面的各个步骤（#137）：从 ui/useBoardPack.ts 拆出的模块级函数，便于单测。
import { type Board } from "../core/board";
import { buildExportSpec, exportSources, planExport, planPackContents, runCancellable, type PackEntryFact } from "../core/boardPack";
import type { PackDialogState } from "./BoardPackDialog";
import type { LogKind } from "../shell/log";
import { exportCancelledText, exportDoneText, exportFailedText, exportHashFailedText, exportLogFields, exportTargetOf, planFailedText } from "./boardPackExportOps";

/** 导出用的端口。 */
export interface ExportDeps {
  packFs: Parameters<typeof planExport>[2];
  io: Parameters<typeof runCancellable>[0];
  facts(spec: ReturnType<typeof exportSources>): Promise<PackEntryFact[]>;
  exportPack(target: string, spec: ReturnType<typeof buildExportSpec>): Promise<{ task_dirs: number; bytes: number }>;
  version(): Promise<string>;
  log(kind: LogKind, fields: Record<string, unknown>): void;
}

/** 导出流程的结果。 */
export type ExportStep =
  | { kind: "failed"; text: string }
  | { kind: "confirm"; boardFile: string; plan: Awaited<ReturnType<typeof planExport>>; contents: ReturnType<typeof planPackContents> };

/** 导出的第一步：算计划、跑 hash 阶段，完了请用户确认。 */
export async function exportPlanStep(
  deps: ExportDeps,
  board: Board,
  boardFile: string,
  userRoot: string,
  progress: (title: string) => () => void,
): Promise<ExportStep> {
  let plan;
  try {
    plan = await planExport(board, userRoot, deps.packFs);
  } catch (e) {
    return { kind: "failed", text: planFailedText(e instanceof Error ? e.message : String(e)) };
  }
  const { stem } = exportTargetOf(boardFile);
  // hash 阶段：服务端给逐文件长度与 sha256，core 据此去重并算预估大小，再请用户确认（包格式 v2）。
  const outcome = await runCancellable(deps.io, progress(`正在计算画板包大小：${stem}`), () => deps.facts(exportSources(plan)));
  if (!outcome.ok) {
    deps.log("board_pack", { action: "export", board_file: boardFile, stage: "hash", result: outcome.result });
    return { kind: "failed", text: outcome.result === "cancelled" ? exportCancelledText : exportHashFailedText(outcome.error) };
  }
  return { kind: "confirm", boardFile, plan, contents: planPackContents(outcome.value) };
}

/** 导出的第二步：打包并下载。 */
export async function exportPackStep(
  deps: ExportDeps,
  boardFile: string,
  plan: Awaited<ReturnType<typeof planExport>>,
  contents: ReturnType<typeof planPackContents>,
  progress: (title: string) => () => void,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const { stem, target } = exportTargetOf(boardFile);
  const spec = buildExportSpec(await deps.version(), boardFile, plan, contents);
  const fields = { ...exportLogFields(boardFile, plan, contents), duplicates: spec.omitted.length };
  const outcome = await runCancellable(deps.io, progress(`正在导出画板包：${stem}`), () => deps.exportPack(target, spec));
  if (!outcome.ok) {
    deps.log("board_pack", { ...fields, result: outcome.result });
    return { ok: false, text: outcome.result === "cancelled" ? exportCancelledText : exportFailedText(outcome.error) };
  }
  deps.log("board_pack", { ...fields, task_dirs: outcome.value.task_dirs, bytes: outcome.value.bytes, result: "ok" });
  return { ok: true, text: exportDoneText(target) };
}

/** 进度对话框的状态。 */
export const progressDialog = (title: string): PackDialogState => ({ stage: "progress", title });

/** 确认对话框的状态。 */
export function confirmDialog(boardFile: string, plan: Awaited<ReturnType<typeof planExport>>, contents: ReturnType<typeof planPackContents>): PackDialogState {
  return { stage: "confirmExport", boardFile, plan, contents };
}
