// 画板包界面流程：导出 = 可取消的 hash 阶段 → 确认（含预估大小）→ 可取消的打包阶段与浏览器下载；浏览器选包 → 可取消进度里上传、判定、导入 → 打开画板。
// 各个步骤在 ui/boardPackOps.ts 与 ui/boardPackImport.ts（#137），这里只留接线。
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

export function useBoardPack(userRoot: string | null, boards: PackBoards, toast: (message: string) => void) {
  const port = useShell();
  const [dialog, setDialog] = useState<PackDialogState | null>(null);

  const progress = (title: string) => () => setDialog(progressDialog(title));

  const prepareExport = useCallback(
    async (key: string) => {
      if (!userRoot) return;
      // 保存失败也继续：导出规格携带当前页面的画板文本，不能因 flushAll 的失败而丢掉备份入口。
      await boards.flushAll();
      const board = boards.getBoard(key);
      const boardFile = boards.boardFileName(key);
      if (!board || !boardFile) return;
      const step = await exportPlanStep(
        {
          packFs: port.core.packFs,
          io: port.pack.io,
          facts: (spec) => port.pack.facts(spec),
          exportPack: (target, spec) => port.pack.exportPack(target, spec),
          version: () => port.ui.version(),
          log: (kind, fields) => port.ui.log(kind, fields),
        },
        board,
        boardFile,
        userRoot,
        progress,
      );
      if (step.kind === "failed") {
        setDialog(null);
        return toast(step.text);
      }
      setDialog(confirmDialog(step.boardFile, step.plan, step.contents));
    },
    [userRoot, boards, toast],
  );

  const confirmExport = useCallback(async () => {
    if (!userRoot || dialog?.stage !== "confirmExport") return;
    const { boardFile, plan, contents } = dialog;
    const result = await exportPackStep(
      {
        packFs: port.core.packFs,
        io: port.pack.io,
        facts: (spec) => port.pack.facts(spec),
        exportPack: (target, spec) => port.pack.exportPack(target, spec),
        version: () => port.ui.version(),
        log: (kind, fields) => port.ui.log(kind, fields),
      },
      boardFile,
      plan,
      contents,
      progress,
    );
    setDialog(null);
    toast(result.text);
  }, [userRoot, dialog, toast]);

  const importPack = useCallback(async () => {
    if (!userRoot) return;
    const deps: PackImportDeps = {
      pickPackFile: () => port.media.pickPackFile(),
      import: (file, options) => port.pack.import(file, options),
      listSlots: () => port.board.list().then((l) => l.slots, () => null),
      openBoard: (path) => boards.openImportedBoard(path),
      log: (kind, fields) => port.ui.log(kind, fields),
    };
    const outcome = await packImportOutcome(deps, progress, (phase) => setDialog((d) => (d?.stage === "progress" ? { ...d, detail: IMPORT_PHASES[phase] } : d)));
    if (outcome.kind === "dialog") return setDialog(outcome.state);
    setDialog(null);
    if (outcome.text) toast(outcome.text);
  }, [userRoot, boards, toast]);

  return {
    prepareExport,
    importPack,
    dialog: dialog && {
      state: dialog,
      onExport: () => void confirmExport(),
      onCancelProgress: () => void port.pack.io.cancel(true),
      onClose: () => setDialog(null),
    },
  };
}
