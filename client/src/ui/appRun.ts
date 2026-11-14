// 运行与重新生成的判定（#137）：从 src/App.tsx 拆出的纯逻辑，便于单测。
// 分派规则本身在 core/submission，这里只做「界面该怎么反应」的判定。
import { regenerateDispatch, runDispatch, type ConfirmItem } from "../core/submission";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";

/** 运行请求的判定结果。 */
export type RunDecision =
  /** 没什么可跑的：给用户一句话。 */
  | { kind: "toast"; message: string }
  /** 没有 API 密钥：先去高级设置填。 */
  | { kind: "needKey" }
  /** 直接提交这一项。 */
  | { kind: "submit"; taskId: string }
  /** 弹二次确认。 */
  | { kind: "confirm"; items: ConfirmItem[]; scope: "selection" | "board" };

/**
 * 运行的分派：单个干净任务直接提交，单个标红 / 没有任务只提示，其余弹二次确认。
 * 选了节点就是「运行选中」，否则是「运行整板」。
 */
export function decideRun(items: ConfirmItem[], selectedCount: number, hasApiKey: boolean): RunDecision {
  const dispatch = runDispatch(items);
  // 没有可提交的任务时先说明原因；真要提交或弹确认窗才需要密钥。
  if (dispatch.kind === "toast") return { kind: "toast", message: dispatch.message };
  if (!hasApiKey) return { kind: "needKey" };
  if (dispatch.kind === "submit") return { kind: "submit", taskId: dispatch.taskId };
  return { kind: "confirm", items, scope: selectedCount ? "selection" : "board" };
}

/** 重新生成的判定结果。 */
export type RegenerateDecision =
  /** 要先确认份数。 */
  | { kind: "confirm"; text: string; copies: number }
  /** 直接重新生成。 */
  | { kind: "regenerate"; copies: number };

/** 重新生成的份数确认文案：模型、份数与提醒。 */
export function regenerateConfirmText(copies: number, modelName: string, note: string | null): string {
  return `将生成 ${copies} 份，模型 ${modelName}。${note ? `\n${note}。` : ""}`;
}

/**
 * 重新生成的分派：多于一份先轻量确认，免得忘了份数多花钱；生成变体由运行器固定一份。
 * fromTaskId 有值时是生成变体（固定一份，不确认）。
 */
export function decideRegenerate(board: Board, table: CapabilityTable, taskNodeId: string, concurrency: number, fromTaskId?: string): RegenerateDecision {
  if (fromTaskId !== undefined) return { kind: "regenerate", copies: 1 };
  const dispatch = regenerateDispatch(board, table, taskNodeId, concurrency);
  if (dispatch.kind === "confirm") {
    return { kind: "confirm", text: regenerateConfirmText(dispatch.copies, dispatch.modelName, dispatch.note), copies: dispatch.copies };
  }
  return { kind: "regenerate", copies: dispatch.copies };
}

/** 没有 API 密钥时的提示与动作。 */
export const NEED_KEY_TEXT = "请先在高级设置中填写 API 密钥";

/** 复制发送文本成功与失败的提示。 */
export const copyTextDone = "已复制发送文本";
export const copyTextFailed = (reason: string) => `复制失败：${reason}`;
