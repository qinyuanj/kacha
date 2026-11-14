// 工作台的动作接线（#137）：从 src/App.tsx 拆出的独立动作函数，便于单测与拆分复杂度。
// 一个动作一个函数：每个的判定都在自己身上，App 只负责把它们接到界面上。
import type { Board } from "../core/board";
import type { BoardChange } from "../core/edit";
import type { RegenerateRequest, RunTarget } from "../core/runner";
import { buildConfirmItems, collectRunFacts, copiesByNode, runScope, type ConfirmItem } from "../core/submission";
import { errorText } from "../core/errors";
import { copyTextDone, copyTextFailed, decideRegenerate, decideRun, NEED_KEY_TEXT } from "./appRun";
import { boardMissingText, boardRenamedText, discardMissingText, stopTasksText } from "./appStartup";

/** 确认项要用的上下文。 */
export interface ConfirmContext {
  table: Parameters<typeof buildConfirmItems>[1];
  discovery: Parameters<typeof buildConfirmItems>[3]["discovery"];
  concurrency: number;
  /** 探测参考图（缺失 / 透明通道）。 */
  probe: Parameters<typeof collectRunFacts>[0];
}

/** 算出这次要确认的条目：与运行时同一套上下文。 */
export async function confirmItemsOf(ctx: ConfirmContext, board: Board, ids: string[], userRoot: string): Promise<ConfirmItem[]> {
  const { missingNodes, alphaByNode } = await collectRunFacts(ctx.probe, board, ids, userRoot);
  return buildConfirmItems(board, ctx.table, ids, { discovery: ctx.discovery, concurrency: ctx.concurrency, missingNodes, alphaByNode });
}

/** 运行的动作要用的依赖。 */
export interface RunDeps {
  activeKey: string | null;
  userRoot: string | null;
  hasApiKey: boolean;
  board: Board | null;
  /** 排队的任务节点（锁定集）。 */
  locked: ReadonlySet<string>;
  selectedIds: string[];
  ctx: ConfirmContext;
  /** 提交一次运行。 */
  startRun(boardKey: string, board: Board, taskIds: string[]): void;
  toast(message: string): void;
  /** 没有密钥时打开高级设置。 */
  openSettings(): void;
  /** 弹出二次确认。 */
  confirm(boardKey: string, board: Board, items: ConfirmItem[], scope: "selection" | "board"): void;
}

/**
 * 运行的分派：单个干净任务直接提交，单个标红 / 没有任务只提示，其余弹二次确认。
 * 返回要提示的话（没有则 null）。
 */
export async function openRunConfirm(deps: RunDeps): Promise<string | null> {
  if (!deps.activeKey || !deps.userRoot) return null;
  const board = deps.board;
  if (!board) return null;
  const items = await confirmItemsOf(deps.ctx, board, runScope(board, deps.ctx.table, deps.selectedIds, deps.locked), deps.userRoot);
  const decision = decideRun(items, deps.selectedIds.length, deps.hasApiKey);
  // 没有可提交的任务时先说明原因；真要提交或弹确认窗才需要密钥。
  if (decision.kind === "toast") {
    deps.toast(decision.message);
    return null;
  }
  if (decision.kind === "needKey") {
    deps.toast(NEED_KEY_TEXT);
    deps.openSettings();
    return null;
  }
  if (decision.kind === "submit") {
    deps.startRun(deps.activeKey, board, [decision.taskId]);
    return null;
  }
  deps.confirm(deps.activeKey, board, decision.items, decision.scope);
  return null;
}

/** 重新生成的动作要用的依赖。 */
export interface RegenerateDeps {
  activeKey: string | null;
  userRoot: string | null;
  hasApiKey: boolean;
  board: Board | null;
  ctx: ConfirmContext;
  /** 向用户确认（false = 取消）。 */
  ask(text: string, options: { title: string; okLabel: string; cancelLabel: string }): Promise<boolean>;
  /** 真正重新生成。 */
  regenerate(target: RunTarget, board: Board, taskNodeId: string, request: RegenerateRequest): Promise<string | null>;
  /** 组装提交目标。 */
  targetOf(boardKey: string): RunTarget;
  toast(message: string): void;
  openSettings(): void;
}

/**
 * 重新生成：多于一份先轻量确认，免得忘了份数多花钱；生成变体由运行器固定一份。
 * 返回要提示的话（没有则 null）。
 */
export async function regenerate(deps: RegenerateDeps, taskNodeId: string, fromTaskId?: string): Promise<string | null> {
  if (!deps.activeKey || !deps.userRoot) return null;
  if (!deps.hasApiKey) {
    deps.toast(NEED_KEY_TEXT);
    deps.openSettings();
    return null;
  }
  const board = deps.board;
  if (!board) return null;
  const decision = decideRegenerate(board, deps.ctx.table, taskNodeId, deps.ctx.concurrency, fromTaskId);
  if (decision.kind === "confirm") {
    const ok = await deps.ask(decision.text, { title: "确认重新生成", okLabel: `重新生成 ${decision.copies} 份`, cancelLabel: "取消" });
    if (!ok) return null;
  }
  const request: RegenerateRequest = fromTaskId === undefined ? { kind: "regenerate", copies: decision.copies } : { kind: "variant", fromTaskId };
  const problem = await deps.regenerate(deps.targetOf(deps.activeKey), board, taskNodeId, request);
  if (problem) deps.toast(`${fromTaskId ? "生成变体" : "重新生成"}失败：${problem}`);
  return null;
}

/** 提交一次运行的依赖。 */
export interface SubmitDeps {
  userRoot: string | null;
  target: RunTarget;
  concurrency: number;
  /** 运行器提交。 */
  submit(target: RunTarget, board: Board, taskIds: string[], copies: ReturnType<typeof copiesByNode>): Promise<string[]>;
  toast(message: string): void;
}

/** 提交一次运行：实际份数按此刻的并发上限算出并随任务固化。 */
export async function startRun(deps: SubmitDeps, board: Board, taskIds: string[]): Promise<void> {
  if (!deps.userRoot) return;
  const problems = await deps.submit(deps.target, board, taskIds, copiesByNode(board, taskIds, deps.concurrency));
  if (problems.length) deps.toast(`${problems.length} 个任务提交失败：${problems[0]}`);
}

/** 关画板前要停掉未完成的任务吗：先问用户。 */
export async function confirmStopTasks(ask: (text: string, options: Record<string, unknown>) => Promise<boolean>, count: number): Promise<boolean> {
  return ask(stopTasksText(count), {
    title: "任务未完成",
    kind: "warning",
    okLabel: "取消全部并关闭",
    cancelLabel: "留在画板",
  });
}

/** 关画板：还有未完成的任务时先确认停掉。 */
export async function closeBoard(
  deps: {
    pending(key: string): number;
    ask(text: string, options: Record<string, unknown>): Promise<boolean>;
    closeRunner(key: string): void;
    closeSessions(key: string): Promise<void>;
  },
  key: string,
): Promise<void> {
  const count = deps.pending(key);
  if (count > 0 && !(await confirmStopTasks(deps.ask, count))) return;
  // 取消并遗忘：重开后失败 / 已取消由任务目录的 outcome.json 给出。
  deps.closeRunner(key);
  await deps.closeSessions(key);
}

/** 从画板列表删除：本页开着的先保存再带版本删；没开的直接删。 */
export async function deleteBoardAt(
  deps: {
    keyOf(path: string): string | null;
    pending(key: string): number;
    ask(text: string, options: Record<string, unknown>): Promise<boolean>;
    closeRunner(key: string): void;
    deleteSessions(key: string): Promise<void>;
    /** 没打开的画板：直接删。 */
    removeDirect(path: string): Promise<void>;
  },
  path: string,
): Promise<void> {
  const key = deps.keyOf(path);
  if (!key) return deps.removeDirect(path);
  const count = deps.pending(key);
  if (count > 0 && !(await confirmStopTasks(deps.ask, count))) return;
  // 先停任务（与关闭标签页同序）再删，免得结果落进一块正在删除的画板；删除失败时停掉的任务不恢复。
  deps.closeRunner(key);
  await deps.deleteSessions(key);
}

/** 归档：本页开着且有未完成的任务时先确认停掉（结果写不进只读画板）。 */
export async function archiveBoardAt(
  deps: {
    keyOf(path: string): string | null;
    pending(key: string): number;
    ask(text: string, options: Record<string, unknown>): Promise<boolean>;
    closeRunner(key: string): void;
    archiveSessions(path: string): Promise<void>;
  },
  path: string,
): Promise<void> {
  const key = deps.keyOf(path);
  if (key) {
    const count = deps.pending(key);
    if (count > 0 && !(await confirmStopTasks(deps.ask, count))) return;
    deps.closeRunner(key);
  }
  await deps.archiveSessions(path);
}

/** 删除前导出画板包：没打开的先打开（导出流程以已打开的画板为准）。 */
export async function exportBoardAt(
  deps: {
    keyOf(path: string): string | null;
    open(path: string, activate: boolean): Promise<boolean>;
    prepareExport(key: string): Promise<void>;
    toast(message: string): void;
  },
  path: string,
): Promise<void> {
  if (!deps.keyOf(path) && !(await deps.open(path, true))) {
    deps.toast(boardMissingText);
    return;
  }
  const key = deps.keyOf(path);
  if (key) await deps.prepareExport(key);
}

/** 放弃一块服务端已不存在的画板：本页内容随之丢弃，先确认。 */
export async function discardMissing(
  deps: {
    ask(text: string, options: Record<string, unknown>): Promise<boolean>;
    closeRunner(key: string): void;
    dropSession(key: string): void;
  },
  key: string,
): Promise<void> {
  const ok = await deps.ask(discardMissingText, {
    title: "关闭画板",
    kind: "warning",
    okLabel: "关闭",
    cancelLabel: "返回",
  });
  if (!ok) return;
  deps.closeRunner(key);
  deps.dropSession(key);
}

/** 从画板列表打开一块画板：打不开时提示。 */
export async function openFromList(
  deps: { open(path: string, activate: boolean): Promise<boolean>; toast(message: string): void },
  path: string,
): Promise<void> {
  const opened = await deps.open(path, true);
  if (!opened) deps.toast(boardRenamedText);
}

/** 复制发送文本。 */
export async function copySendText(deps: { copyText(text: string): Promise<void>; toast(message: string): void }, text: string): Promise<void> {
  try {
    await deps.copyText(text);
    deps.toast(copyTextDone);
  } catch (e) {
    deps.toast(copyTextFailed(errorText(e)));
  }
}

/** 看板板变更的接线：提交与结果立即落盘。 */
export function applyGuarded(apply: (key: string, change: BoardChange) => unknown, flushNow: (key: string) => Promise<void>, key: string, change: BoardChange): unknown {
  const result = apply(key, change);
  // 提交与结果立即落盘，避免浏览器关页 / 刷新时丢失 last_submitted 或新结果节点。
  if (result && (change.kind === "submitted" || change.kind === "runResult")) void flushNow(key);
  return result;
}
