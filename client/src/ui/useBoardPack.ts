// 画板包界面流程：导出 = 可取消的 hash 阶段 → 确认（含预估大小）→ 可取消的打包阶段与浏览器下载；浏览器选包 → 可取消进度里上传、判定、导入 → 打开画板。
// 各个步骤在 ui/boardPackOps.ts 与 ui/boardPackImportOps.ts（#137），这里只留接线。
import { useCallback, useState } from "react";
import { type Board } from "../core/board";
import type { PackDialogState } from "./BoardPackDialog";
import { useShell } from "./shell";
import { IMPORT_PHASES } from "./boardPackImport";
import { confirmDialog, exportPackStep, exportPlanStep, progressDialog } from "./boardPackOps";
import { packImportOutcome, type PackImportDeps } from "./boardPackImportOps";

interface PackBoards {
  flushAll: () => Promise<void>;
  getBoard: (key: string) => Board | null;
  boardFileName: (key: string) => string | null;
  openImportedBoard: (path: string) => Promise<void>;
}

/** 导出用到的端口。 */
function exportDeps(port: ReturnType<typeof useShell>): Parameters<typeof exportPlanStep>[0] {
  return {
    packFs: port.core.packFs,
    io: port.pack.io,
    facts: (spec) => port.pack.facts(spec),
    exportPack: (target, spec) => port.pack.exportPack(target, spec),
    version: () => port.ui.version(),
    log: (kind, fields) => port.ui.log(kind, fields),
  };
}

/** 导入用到的端口。 */
function importDeps(port: ReturnType<typeof useShell>, openImportedBoard: (path: string) => Promise<void>): PackImportDeps {
  return {
    pickPackFile: () => port.media.pickPackFile(),
    import: (file, options) => port.pack.import(file, options),
    listSlots: () => port.board.list().then((l) => l.slots, () => null),
    openBoard: (path) => openImportedBoard(path),
    log: (kind, fields) => port.ui.log(kind, fields),
  };
}

/** 导出：算计划与 hash 阶段。 */
function useExportPrepare(
  userRoot: string | null,
  boards: PackBoards,
  toast: (message: string) => void,
  setDialog: React.Dispatch<React.SetStateAction<PackDialogState | null>>,
): { prepareExport(key: string): Promise<void> } {
  const port = useShell();
  const progress = (title: string) => () => setDialog(progressDialog(title));
  const prepareExport = useCallback(
    async (key: string) => {
      if (!userRoot) return;
      // 保存失败也继续：导出规格携带当前页面的画板文本，不能因 flushAll 的失败而丢掉备份入口。
      await boards.flushAll();
      const board = boards.getBoard(key);
      const boardFile = boards.boardFileName(key);
      if (!board || !boardFile) return;
      const step = await exportPlanStep(exportDeps(port), board, boardFile, userRoot, progress);
      if (step.kind === "failed") {
        setDialog(null);
        return toast(step.text);
      }
      setDialog(confirmDialog(step.boardFile, step.plan, step.contents));
    },
    [userRoot, boards, toast],
  );
  return { prepareExport };
}

/** 导出：确认之后打包与下载。 */
function useExportConfirm(
  userRoot: string | null,
  toast: (message: string) => void,
  setDialog: React.Dispatch<React.SetStateAction<PackDialogState | null>>,
): { confirmExport(state: PackDialogState): Promise<void> } {
  const port = useShell();
  const progress = (title: string) => () => setDialog(progressDialog(title));
  const confirmExport = useCallback(
    async (state: PackDialogState) => {
      if (!userRoot || state.stage !== "confirmExport") return;
      const { boardFile, plan, contents } = state;
      const result = await exportPackStep(exportDeps(port), boardFile, plan, contents, progress);
      setDialog(null);
      toast(result.text);
    },
    [userRoot, toast],
  );
  return { confirmExport };
}

/** 导出：算计划、hash 阶段与确认。 */
function useExport(
  userRoot: string | null,
  boards: PackBoards,
  toast: (message: string) => void,
  setDialog: React.Dispatch<React.SetStateAction<PackDialogState | null>>,
): { prepareExport(key: string): Promise<void>; confirmExport(state: PackDialogState): Promise<void> } {
  const prepare = useExportPrepare(userRoot, boards, toast, setDialog);
  const confirm = useExportConfirm(userRoot, toast, setDialog);
  return { prepareExport: prepare.prepareExport, confirmExport: confirm.confirmExport };
}

/** 导入：选包、预检、上传与判定。 */
function useImport(
  userRoot: string | null,
  boards: PackBoards,
  toast: (message: string) => void,
  setDialog: React.Dispatch<React.SetStateAction<PackDialogState | null>>,
): { importPack(): Promise<void> } {
  const port = useShell();
  const progress = (title: string) => () => setDialog(progressDialog(title));
  const importPack = useCallback(async () => {
    if (!userRoot) return;
    const outcome = await packImportOutcome(importDeps(port, boards.openImportedBoard), progress, (phase) =>
      setDialog((d) => (d?.stage === "progress" ? { ...d, detail: IMPORT_PHASES[phase] } : d)),
    );
    if (outcome.kind === "dialog") return setDialog(outcome.state);
    if (outcome.kind === "message") {
      setDialog(null);
      await port.ui.message(outcome.text, { title: "无法导入画板包" });
      return;
    }
    setDialog(null);
    if (outcome.text) toast(outcome.text);
  }, [userRoot, boards, toast]);
  return { importPack };
}

export function useBoardPack(userRoot: string | null, boards: PackBoards, toast: (message: string) => void) {
  const port = useShell();
  const [dialog, setDialog] = useState<PackDialogState | null>(null);
  const { prepareExport, confirmExport } = useExport(userRoot, boards, toast, setDialog);
  const { importPack } = useImport(userRoot, boards, toast, setDialog);

  return {
    prepareExport,
    importPack,
    dialog: dialog && {
      state: dialog,
      onExport: () => void confirmExport(dialog),
      onCancelProgress: () => void port.pack.io.cancel(true),
      onClose: () => setDialog(null),
    },
  };
}