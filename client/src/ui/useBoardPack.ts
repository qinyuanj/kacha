// 画板包界面流程：导出 = 可取消的 hash 阶段 → 确认（含预估大小）→ 可取消的打包阶段与浏览器下载；浏览器选包 → 可取消进度里上传、判定、导入 → 打开画板。
// 导入结局的判定在 ui/boardPackImport.ts，导出的各步在 ui/boardPackExportOps.ts（#137），这里只留接线。
import { useCallback, useState } from "react";
import { type Board } from "../core/board";
import { buildExportSpec, exportSources, planExport, planPackContents, runCancellable } from "../core/boardPack";
import type { PackDialogState } from "./BoardPackDialog";
import { errorText } from "../core/errors";
import { slotsRefusal } from "./boardText";
import { useShell } from "./shell";
import { IMPORT_PHASES, importOutcome } from "./boardPackImport";
import { exportCancelledText, exportDoneText, exportFailedText, exportHashFailedText, exportLogFields, exportTargetOf, planFailedText } from "./boardPackExportOps";

interface PackBoards {
  flushAll: () => Promise<void>;
  getBoard: (key: string) => Board | null;
  boardFileName: (key: string) => string | null;
  openImportedBoard: (path: string) => Promise<void>;
}

export function useBoardPack(userRoot: string | null, boards: PackBoards, toast: (message: string) => void) {
  const port = useShell();
  const [dialog, setDialog] = useState<PackDialogState | null>(null);

  const progress = (title: string) => () => setDialog({ stage: "progress", title });

  const prepareExport = useCallback(
    async (key: string) => {
      if (!userRoot) return;
      // 保存失败也继续：导出规格携带当前页面的画板文本，不能因 flushAll 的失败而丢掉备份入口。
      await boards.flushAll();
      const board = boards.getBoard(key);
      const boardFile = boards.boardFileName(key);
      if (!board || !boardFile) return;
      const { stem } = exportTargetOf(boardFile);
      let plan;
      try {
        plan = await planExport(board, userRoot, port.core.packFs);
      } catch (e) {
        return toast(planFailedText(errorText(e)));
      }
      // hash 阶段：服务端给逐文件长度与 sha256，core 据此去重并算预估大小，再请用户确认（包格式 v2）。
      const outcome = await runCancellable(port.pack.io, progress(`正在计算画板包大小：${stem}`), () => port.pack.facts(exportSources(plan)));
      if (!outcome.ok) {
        setDialog(null);
        port.ui.log("board_pack", { action: "export", board_file: boardFile, stage: "hash", result: outcome.result });
        return toast(outcome.result === "cancelled" ? exportCancelledText : exportHashFailedText(outcome.error));
      }
      setDialog({ stage: "confirmExport", boardFile, plan, contents: planPackContents(outcome.value) });
    },
    [userRoot, boards, toast],
  );

  const confirmExport = useCallback(async () => {
    if (!userRoot || dialog?.stage !== "confirmExport") return;
    const { boardFile, plan, contents } = dialog;
    const { stem, target } = exportTargetOf(boardFile);
    const spec = buildExportSpec(await port.ui.version(), boardFile, plan, contents);
    const fields = { ...exportLogFields(boardFile, plan, contents), duplicates: spec.omitted.length };
    const outcome = await runCancellable(port.pack.io, progress(`正在导出画板包：${stem}`), () => port.pack.exportPack(target, spec));
    setDialog(null);
    if (outcome.ok) {
      port.ui.log("board_pack", { ...fields, task_dirs: outcome.value.task_dirs, bytes: outcome.value.bytes, result: "ok" });
      toast(exportDoneText(target));
    } else {
      port.ui.log("board_pack", { ...fields, result: outcome.result });
      toast(outcome.result === "cancelled" ? exportCancelledText : exportFailedText(outcome.error));
    }
  }, [userRoot, dialog, toast]);

  const importPack = useCallback(async () => {
    if (!userRoot) return;
    try {
      const file = await port.media.pickPackFile();
      if (!file) return;
      const result = await port.pack.import(file, {
        file,
        openBoard: boards.openImportedBoard,
        // 画板位预检（#89）：读不到列表时不拦，服务端合并前仍会检查。
        slotsRefusal: async (adding) => {
          const slots = await port.board.list().then((l) => l.slots, () => null);
          return slots && slotsRefusal(slots, adding);
        },
        onStage: progress(`正在导入画板包：${file.name}`),
        onPhase: (phase) => setDialog((d) => (d?.stage === "progress" ? { ...d, detail: IMPORT_PHASES[phase] } : d)),
        log: (kind, fields) => port.ui.log(kind, fields),
      });
      const outcome = importOutcome(result);
      if (outcome.kind === "toast") {
        setDialog(null);
        return toast(outcome.text);
      }
      setDialog(outcome.state);
    } catch (e) {
      setDialog(null);
      toast(`导入画板包失败：${errorText(e)}`);
    }
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
