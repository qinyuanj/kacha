// 工作台的运行相关接线（#137）：从 src/App.tsx 拆出的 hook，让 App 只留界面。
import { useCallback } from "react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import type { BoardChange } from "../core/edit";
import type { Runner, RunTarget } from "../core/runner";
import type { ConfirmItem } from "../core/submission";
import type { Discovery } from "../core/settings";
import { useShell } from "./shell";
import { confirmItemsOf, copySendText, openRunConfirm, regenerate as regenerateAction, startRun } from "./appActions";

/** 运行与确认需要的上下文。 */
export interface RunContext {
  table: CapabilityTable;
  discovery: Discovery;
  concurrency: number;
  probe: { inspectImage(absPath: string): Promise<{ has_alpha: boolean }> };
}

/** 运行相关的回调。 */
export interface RunCallbacks {
  /** 运行：单个干净任务直接提交，其余弹二次确认。 */
  openRun(selectedIds: string[]): Promise<void>;
  /** 查看发送文本。 */
  viewSendText(taskNodeId: string): Promise<void>;
  /** 复制发送文本。 */
  copyText(text: string): void;
  /** 重新生成 / 生成变体。 */
  doRegenerate(taskNodeId: string, fromTaskId?: string): Promise<void>;
  /** 取消任务节点。 */
  cancelTask(taskNodeId: string): void;
  /** 提交一次运行（二次确认框点了「运行」之后调它）。 */
  runNow(boardKey: string, board: Board, taskIds: string[]): Promise<void>;
  /** 当前画板是否在运行。 */
  runState: RunSnapshot;
}

/** 运行器的快照形状（避免在这里依赖 useRunner 的内部类型）。 */
export interface RunSnapshot {
  board(key: string): { locked: ReadonlySet<string>; nodes: ReadonlyMap<string, unknown>; handled: ReadonlySet<string> };
}

/** 运行相关的接线。 */
export function useRunCallbacks(options: {
  activeKey: string | null;
  userRoot: string | null;
  apiKey: string;
  boards: { getBoard(key: string): Board | null; boardFileName(key: string): string | null };
  runner: Runner;
  runState: RunSnapshot;
  ctx: RunContext;
  targetOf(boardKey: string): RunTarget;
  toast(message: string): void;
  openSettings(): void;
  setConfirm(confirm: { boardKey: string; board: Board; items: ConfirmItem[]; scope: "selection" | "board" } | null): void;
  setSendText(item: ConfirmItem): void;
  applyOne(key: string, change: BoardChange): unknown;
}): RunCallbacks {
  const { activeKey, userRoot, apiKey, boards, runner, runState, ctx, targetOf, toast, openSettings, setConfirm, setSendText } = options;
  const port = useShell();

  const runNow = useCallback(
    async (boardKey: string, board: Board, taskIds: string[]) => {
      setConfirm(null);
      await startRun(
        {
          userRoot,
          target: targetOf(boardKey),
          concurrency: ctx.concurrency,
          submit: (t, b, ids, copies) => runner.submit(t, b, ids, copies),
          toast,
        },
        board,
        taskIds,
      );
    },
    [userRoot, targetOf, ctx.concurrency, runner, toast, setConfirm],
  );

  // 单个干净任务直接提交，单个标红 / 没有任务只提示；其余弹二次确认（分派规则见 runDispatch）。
  const openRun = useCallback(
    async (selectedIds: string[]) => {
      await openRunConfirm({
        activeKey,
        userRoot,
        hasApiKey: !!apiKey,
        board: activeKey ? boards.getBoard(activeKey) : null,
        locked: runState.board(activeKey ?? "").locked,
        selectedIds,
        ctx,
        startRun: (k, b, ids) => void runNow(k, b, ids),
        toast,
        openSettings,
        confirm: (boardKey, board, items, scope) => setConfirm({ boardKey, board, items, scope }),
      });
    },
    [activeKey, userRoot, apiKey, boards, runState, ctx, runNow, toast, openSettings, setConfirm],
  );

  const viewSendText = useCallback(
    async (taskNodeId: string) => {
      if (!activeKey || !userRoot) return;
      const board = boards.getBoard(activeKey);
      if (!board) return;
      const [item] = await confirmItemsOf(ctx, board, [taskNodeId], userRoot);
      if (item) setSendText(item);
    },
    [activeKey, userRoot, boards, ctx, setSendText],
  );

  const copyText = useCallback(
    // 内网 HTTP 不是安全上下文，navigator.clipboard 不可用；壳层用 textarea 回退。
    (text: string) => void copySendText({ copyText: (t) => port.media.copyText(t), toast }, text),
    [toast],
  );

  const doRegenerate = useCallback(
    async (taskNodeId: string, fromTaskId?: string) => {
      await regenerateAction(
        {
          activeKey,
          userRoot,
          hasApiKey: !!apiKey,
          board: activeKey ? boards.getBoard(activeKey) : null,
          ctx,
          ask: (text, o) => port.ui.ask(text, o),
          regenerate: (t, b, id, request) => runner.regenerate(t, b, id, request),
          targetOf,
          toast,
          openSettings,
        },
        taskNodeId,
        fromTaskId,
      );
    },
    [activeKey, userRoot, apiKey, boards, ctx, runner, targetOf, toast, openSettings],
  );

  const cancelTask = useCallback(
    (taskNodeId: string) => (activeKey ? runner.cancel({ kind: "task", boardKey: activeKey, taskNodeId }) : undefined),
    [runner, activeKey],
  );

  return { openRun, viewSendText, copyText, doRegenerate, cancelTask, runState, runNow };
}