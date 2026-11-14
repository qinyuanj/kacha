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
  const run = useRunSubmit({ userRoot, runner, ctx, targetOf, toast, setConfirm });
  const actions = useRunActions({ activeKey, userRoot, apiKey, boards, runner, runState, ctx, targetOf, toast, openSettings, setConfirm, setSendText, runNow: run.runNow });
  return { ...actions, runState, runNow: run.runNow };
}

/** 提交一次运行的接线。 */
function useRunSubmit(options: {
  userRoot: string | null;
  runner: Runner;
  ctx: RunContext;
  targetOf(boardKey: string): RunTarget;
  toast(message: string): void;
  setConfirm(confirm: { boardKey: string; board: Board; items: ConfirmItem[]; scope: "selection" | "board" } | null): void;
}): { runNow(boardKey: string, board: Board, taskIds: string[]): Promise<void> } {
  const { userRoot, runner, ctx, targetOf, toast, setConfirm } = options;
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
  return { runNow };
}

/** 运行的分派：单个干净任务直接提交，其余弹二次确认。 */
function useOpenRun(options: {
  activeKey: string | null;
  userRoot: string | null;
  apiKey: string;
  boards: { getBoard(key: string): Board | null };
  runner: Runner;
  runState: RunSnapshot;
  ctx: RunContext;
  toast(message: string): void;
  openSettings(): void;
  setConfirm(confirm: { boardKey: string; board: Board; items: ConfirmItem[]; scope: "selection" | "board" } | null): void;
  runNow(boardKey: string, board: Board, taskIds: string[]): Promise<void>;
}): { openRun(selectedIds: string[]): Promise<void> } {
  const { activeKey, userRoot, apiKey, boards, runState, ctx, toast, openSettings, setConfirm, runNow } = options;
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
  return { openRun };
}

/** 查看发送文本与复制。 */
function useTextActions(options: {
  activeKey: string | null;
  userRoot: string | null;
  boards: { getBoard(key: string): Board | null };
  ctx: RunContext;
  toast(message: string): void;
  setSendText(item: ConfirmItem): void;
}): { viewSendText(taskNodeId: string): Promise<void>; copyText(text: string): void } {
  const { activeKey, userRoot, boards, ctx, toast, setSendText } = options;
  const port = useShell();
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
  return { viewSendText, copyText };
}

/** 重新生成与取消任务。 */
function useRegenerateActions(options: {
  activeKey: string | null;
  userRoot: string | null;
  apiKey: string;
  boards: { getBoard(key: string): Board | null };
  runner: Runner;
  ctx: RunContext;
  targetOf(boardKey: string): RunTarget;
  toast(message: string): void;
  openSettings(): void;
}): { doRegenerate(taskNodeId: string, fromTaskId?: string): Promise<void>; cancelTask(taskNodeId: string): void } {
  const { activeKey, userRoot, apiKey, boards, runner, ctx, targetOf, toast, openSettings } = options;
  const port = useShell();
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
  return { doRegenerate, cancelTask };
}

/** 运行相关的其余接线：确认、查看文本、复制与重新生成。 */
function useRunActions(options: {
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
  runNow(boardKey: string, board: Board, taskIds: string[]): Promise<void>;
}): Omit<RunCallbacks, "runState" | "runNow"> {
  const { activeKey, userRoot, apiKey, boards, runner, runState, ctx, targetOf, toast, openSettings, setConfirm, setSendText, runNow } = options;
  const open = useOpenRun({ activeKey, userRoot, apiKey, boards, runner, runState, ctx, toast, openSettings, setConfirm, runNow });
  const text = useTextActions({ activeKey, userRoot, boards, ctx, toast, setSendText });
  const regen = useRegenerateActions({ activeKey, userRoot, apiKey, boards, runner, ctx, targetOf, toast, openSettings });
  return { openRun: open.openRun, viewSendText: text.viewSendText, copyText: text.copyText, doRegenerate: regen.doRegenerate, cancelTask: regen.cancelTask };
}