// 画板包界面流程：导出确认 → 浏览器下载与可取消进度；浏览器选包 → 上传 → 判定 → 导入 → 打开画板。
import { browser, ipc, packUpload } from "../shell/ipc";
import { pickPackFile } from "../shell/packFile";
import { useCallback, useState } from "react";
import { BOARD_EXTENSION, type Board } from "../core/board";
import { buildExportSpec, importPack as importPackIn, PACK_EXTENSION, planExport, runCancellable } from "../core/boardPack";
import { packFs, packIo } from "../shell/adapters";
import { logEvent } from "../shell/log";
import type { PackDialogState } from "./BoardPackDialog";

interface PackBoards {
  flushAll: () => Promise<void>;
  getBoard: (key: string) => Board | null;
  boardFileName: (key: string) => string | null;
  addImportedBoard: (board: Board) => Promise<string>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useBoardPack(userRoot: string | null, boards: PackBoards, toast: (message: string) => void) {
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
      try {
        setDialog({ stage: "confirmExport", boardFile, plan: await planExport(board, userRoot, packFs) });
      } catch (e) {
        toast(`无法导出画板包：${errorText(e)}`);
      }
    },
    [userRoot, boards, toast],
  );

  const confirmExport = useCallback(async () => {
    if (!userRoot || dialog?.stage !== "confirmExport") return;
    const { boardFile, plan } = dialog;
    const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
    const target = `${stem}${PACK_EXTENSION}`;
    const spec = buildExportSpec(await browser.version(), boardFile, plan);
    const fields = { action: "export", board_file: boardFile, task_dirs: plan.taskDirs.length, missing: plan.missing.length };
    const outcome = await runCancellable(packIo, progress(`正在导出画板包：${stem}`), () => ipc.boardPackExport(target, spec));
    setDialog(null);
    if (outcome.ok) {
      logEvent("board_pack", { ...fields, task_dirs: outcome.value.task_dirs, bytes: outcome.value.bytes, result: "ok" });
      toast(`已导出画板包 ${target}`);
    } else {
      logEvent("board_pack", { ...fields, result: outcome.result });
      toast(outcome.result === "cancelled" ? "已取消导出画板包" : `导出画板包失败：${outcome.error}`);
    }
  }, [userRoot, dialog, toast]);

  const importPack = useCallback(async () => {
    if (!userRoot) return;
    try {
      const file = await pickPackFile();
      if (!file) return;
      // 上传暂在导入前调用；后续票会把它移进可取消的导入流程。
      const id = await packUpload.upload(file);
      const result = await importPackIn(packIo, {
        packPath: id,
        displayName: file.name,
        addBoard: (board) => boards.addImportedBoard(board),
        onStage: progress(`正在导入画板包：${file.name}`),
        log: logEvent,
      });
      switch (result.kind) {
        case "newer":
          await browser.message(result.message, { title: "无法导入画板包" });
          return;
        case "corrupt":
          return toast(`无法导入画板包：${result.reason}`);
        case "cancelled":
          setDialog(null);
          return toast("已取消导入；已移入的任务目录保留");
        case "failed":
          setDialog(null);
          return toast(`导入画板包失败：${result.error}`);
        case "done": {
          const { summary, writeError } = result;
          if (writeError || summary.conflicts.length) setDialog({ stage: "importDone", message: summary.message, conflicts: summary.conflicts, error: writeError });
          else {
            setDialog(null);
            toast(summary.message);
          }
        }
      }
    } catch (e) {
      toast(`导入画板包失败：${errorText(e)}`);
    }
  }, [userRoot, boards, toast]);

  return {
    prepareExport,
    importPack,
    dialog: dialog && {
      state: dialog,
      onExport: () => void confirmExport(),
      onCancelProgress: () => void packIo.cancel(true),
      onClose: () => setDialog(null),
    },
  };
}
