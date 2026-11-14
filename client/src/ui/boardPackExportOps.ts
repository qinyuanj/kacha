// 画板包导出的各个步骤（#137）：从 ui/useBoardPack.ts 拆出的模块级函数，便于单测。
import { BOARD_EXTENSION, type Board } from "../core/board";
import { buildExportSpec, exportSources, PACK_EXTENSION, planExport, planPackContents, runCancellable, type PackEntryFact, type PackIo } from "../core/boardPack";

/** 导出要用到的端口。 */
export interface ExportPorts {
  /** 画板目录下的文件（判断参考图在不在）。 */
  packFs: Parameters<typeof planExport>[2];
  /** 进度对话框与取消。 */
  io: PackIo;
  /** 服务端给逐文件长度与 sha256。 */
  facts(spec: ReturnType<typeof exportSources>): Promise<PackEntryFact[]>;
  /** 服务端打包并下载。 */
  exportPack(target: string, spec: ReturnType<typeof buildExportSpec>): Promise<{ task_dirs: number; bytes: number }>;
  /** 版本号（写进导出规格）。 */
  version(): Promise<string>;
  /** 日志。 */
  log(kind: string, fields: Record<string, unknown>): void;
}

/** 导出的计划：画板要打包哪些内容。 */
export interface ExportPlan {
  plan: Awaited<ReturnType<typeof planExport>>;
}

/** 算导出计划。 */
export async function planOf(board: Board, userRoot: string, ports: ExportPorts): Promise<ExportPlan> {
  return { plan: await planExport(board, userRoot, ports.packFs) };
}

/** 算导出计划失败时的提示。 */
export const planFailedText = (reason: string) => `无法导出画板包：${reason}`;

/** hash 阶段取消时的提示。 */
export const exportCancelledText = "已取消导出画板包";

/** hash 阶段失败时的提示。 */
export const exportHashFailedText = (reason: string) => `无法导出画板包：${reason}`;

/** 导出成功时的提示。 */
export const exportDoneText = (target: string) => `已导出画板包 ${target}`;

/** 导出失败时的提示。 */
export const exportFailedText = (reason: string) => `导出画板包失败：${reason}`;

/** 导出目标的文件名：画板名加 .ugcpack。 */
export const exportTargetOf = (boardFile: string) => {
  const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
  return { stem, target: `${stem}${PACK_EXTENSION}` };
};

/** hash 阶段：服务端给逐文件长度与 sha256，core 据此去重并算预估大小。 */
export async function hashStage(
  ports: ExportPorts,
  plan: ExportPlan["plan"],
  progress: () => void,
): Promise<{ ok: true; contents: ReturnType<typeof planPackContents> } | { ok: false; cancelled: boolean; error: string }> {
  const outcome = await runCancellable(ports.io, progress, () => ports.facts(exportSources(plan)));
  if (!outcome.ok) return { ok: false, cancelled: outcome.result === "cancelled", error: outcome.error };
  return { ok: true, contents: planPackContents(outcome.value) };
}

/** 打包阶段：服务端边打包边发下载流。 */
export async function packStage(
  ports: ExportPorts,
  boardFile: string,
  plan: ExportPlan["plan"],
  contents: ReturnType<typeof planPackContents>,
  progress: () => void,
): Promise<{ ok: true; taskDirs: number; bytes: number } | { ok: false; cancelled: boolean; error: string }> {
  const { target } = exportTargetOf(boardFile);
  const spec = buildExportSpec(await ports.version(), boardFile, plan, contents);
  const outcome = await runCancellable(ports.io, progress, () => ports.exportPack(target, spec));
  if (!outcome.ok) return { ok: false, cancelled: outcome.result === "cancelled", error: outcome.error };
  return { ok: true, taskDirs: outcome.value.task_dirs, bytes: outcome.value.bytes };
}

/** 导出的日志字段（不含提示词与报错原文）。 */
export function exportLogFields(boardFile: string, plan: ExportPlan["plan"], contents: ReturnType<typeof planPackContents>): Record<string, unknown> {
  return {
    action: "export",
    board_file: boardFile,
    task_dirs: plan.taskDirs.length,
    missing: plan.missing.length,
    duplicates: contents.bytes < contents.totalBytes ? 1 : 0,
    estimated_bytes: contents.bytes,
  };
}
