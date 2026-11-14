// 画板包界面流程：导出 = 可取消的 hash 阶段 → 确认（含预估大小）→ 可取消的打包阶段与浏览器下载；浏览器选包 → 可取消进度里上传、判定、导入 → 打开画板。
import { useCallback, useState } from "react";
import { BOARD_EXTENSION, type Board } from "../core/board";
import { buildExportSpec, exportSources, PACK_EXTENSION, planExport, planPackContents, runCancellable, type ImportPhase } from "../core/boardPack";
import type { PackDialogState } from "./BoardPackDialog";
import { errorText } from "../core/errors";
import { isSlotsFullText, PACK_IMPORT_TEXT, slotsRefusal } from "./boardText";
import { useShell } from "./shell";
import { unavailableMessage } from "../shell/port";

interface PackBoards {
  flushAll: () => Promise<void>;
  getBoard: (key: string) => Board | null;
  boardFileName: (key: string) => string | null;
  openImportedBoard: (path: string) => Promise<void>;
}

/** 导入进度对话框里各步的说明（#62）。 */
const IMPORT_PHASES: Record<ImportPhase, string> = {
  check: "正在检查画板包…",
  existing: "正在比对服务端已有的任务目录…",
  hash: "正在计算内容校验值…",
  upload: "正在上传缺少的内容…",
  merge: "正在合并任务目录…",
};

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
      const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
      // 整段包住：端口拒绝时（桌面壳本切片没有画板包导出）要说出「尚不可用」，
      // 不能既不报错也不给消息——runCancellable 复位取消标记就在它自己的 try 之外，漏了就静默。
      try {
        let plan;
        try {
          plan = await planExport(board, userRoot, port.core.packFs);
        } catch (e) {
          return toast(`无法导出画板包：${errorText(e)}`);
        }
        // hash 阶段：服务端给逐文件长度与 sha256，core 据此去重并算预估大小，再请用户确认（包格式 v2）。
        // runCancellable 把异常压成文本，类别就丢了：端口说「尚不可用」时在这里先记下来。
        let unavailable: string | null = null;
        const outcome = await runCancellable(port.pack.io, progress(`正在计算画板包大小：${stem}`), async () => {
          try {
            return await port.pack.facts(exportSources(plan));
          } catch (e) {
            unavailable = unavailableMessage(e);
            throw e;
          }
        });
        if (!outcome.ok) {
          setDialog(null);
          port.ui.log("board_pack", { action: "export", board_file: boardFile, stage: "hash", result: outcome.result });
          // 端口说这项能力还没有（桌面壳本切片没有画板包导出）：说清「尚不可用」。
          return toast(unavailable ?? (outcome.result === "cancelled" ? "已取消导出画板包" : `无法导出画板包：${outcome.error}`));
        }
        setDialog({ stage: "confirmExport", boardFile, plan, contents: planPackContents(outcome.value) });
      } catch (e) {
        setDialog(null);
        // 端口说「尚不可用」就说它；其它失败按原文案，不冒充成功。
        const message = unavailableMessage(e);
        return toast(message ?? `无法导出画板包：${errorText(e)}`);
      }
    },
    [userRoot, boards, toast],
  );

  const confirmExport = useCallback(async () => {
    if (!userRoot || dialog?.stage !== "confirmExport") return;
    const { boardFile, plan, contents } = dialog;
    const stem = boardFile.slice(0, -BOARD_EXTENSION.length);
    const target = `${stem}${PACK_EXTENSION}`;
    const spec = buildExportSpec(await port.ui.version(), boardFile, plan, contents);
    const fields = { action: "export", board_file: boardFile, task_dirs: plan.taskDirs.length, missing: plan.missing.length, duplicates: spec.omitted.length, estimated_bytes: contents.bytes };
    // 端口可能拒绝（桌面壳本切片没有画板包导出）：runCancellable 的取消复位在它自己的 try 之外，
    // 这里也整段包住，不能静默。
    let outcome;
    try {
      outcome = await runCancellable(port.pack.io, progress(`正在导出画板包：${stem}`), () => port.pack.exportPack(target, spec));
    } catch (e) {
      setDialog(null);
      const message = unavailableMessage(e);
      return toast(message ?? `导出画板包失败：${errorText(e)}`);
    }
    setDialog(null);
    if (outcome.ok) {
      port.ui.log("board_pack", { ...fields, task_dirs: outcome.value.task_dirs, bytes: outcome.value.bytes, result: "ok" });
      toast(`已导出画板包 ${target}`);
    } else {
      port.ui.log("board_pack", { ...fields, result: outcome.result });
      toast(outcome.result === "cancelled" ? "已取消导出画板包" : `导出画板包失败：${outcome.error}`);
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
      switch (result.kind) {
        case "newer":
          setDialog(null);
          await port.ui.message(result.message, { title: "无法导入画板包" });
          return;
        case "corrupt":
          setDialog(null);
          return toast(`无法导入画板包：${result.reason}`);
        case "cancelled":
          setDialog(null);
          return toast(PACK_IMPORT_TEXT.cancelled);
        case "slotsFull":
          setDialog(null);
          return toast(result.message);
        case "failed":
        case "commitFailed":
          // 服务端合并前按画板位拒绝（两页抢最后的位）：它的报错就是统一文案，不加前缀，此时什么都没合并。
          if (isSlotsFullText(result.error)) {
            setDialog(null);
            return toast(result.error);
          }
          // 导入请求失败时任务目录可能已移入一部分：用弹窗说明画板没有写入，而不是一闪而过的提示。
          if (result.kind === "commitFailed") return setDialog({ stage: "importDone", message: PACK_IMPORT_TEXT.failed(result.error), conflicts: [], notice: PACK_IMPORT_TEXT.commitFailed });
          setDialog(null);
          return toast(PACK_IMPORT_TEXT.failed(result.error));
        case "done": {
          const { summary, writeError } = result;
          if (writeError || summary.conflicts.length) setDialog({ stage: "importDone", message: summary.message, conflicts: summary.conflicts, notice: writeError && PACK_IMPORT_TEXT.openFailed(writeError) });
          else {
            setDialog(null);
            toast(summary.message);
          }
        }
      }
    } catch (e) {
      setDialog(null);
      // 端口说这项能力还没有（桌面壳本切片没有画板包导入）：说清「尚不可用」。
      const unavailable = unavailableMessage(e);
      toast(unavailable ?? PACK_IMPORT_TEXT.failed(errorText(e)));
    }
  }, [userRoot, boards, toast]);

  return {
    prepareExport,
    importPack,
    dialog: dialog && {
      state: dialog,
      onExport: () => void confirmExport(),
      onCancelProgress: () => {
        // 桌面壳本切片没有画板包导出：取消也可能被端口拒绝，别让它冒成未捕获异常。
        void port.pack.io.cancel(true).catch(() => undefined);
      },
      onClose: () => setDialog(null),
    },
  };
}
