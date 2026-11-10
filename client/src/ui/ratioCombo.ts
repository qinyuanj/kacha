// 宽高比组合框（ui/nodes.tsx 的 RatioCombo）的纯逻辑：显示文本、手填提交动作与预设项状态。
// 抽成纯函数只为把组合框的复杂度压到阈值内、并让这些判定能直接测；调用方仍是节点组件。
import type { SizeRule } from "../core/capabilities";
import { autoRatioLabel, commitRatioInput, isAutoRatio, ratioRangeText, type SizeSpec } from "../core/size";

/** 组合框里「自动」项的 value。 */
export const AUTO_RATIO = "auto";

/** 输入框显示的文本：自动时是推测标签，手动但当前档发不出去时带「（不支持）」。 */
export function ratioComboText(rule: SizeRule, spec: SizeSpec, unsupported: boolean): string {
  if (isAutoRatio(spec)) return autoRatioLabel(rule, spec);
  if (unsupported) return `${spec.ratio}（不支持）`;
  return spec.ratio ?? "";
}

/** 组合框外层的类名：手动的宽高比在当前档发不出去时标「不支持」。 */
export function ratioComboClass(unsupported: boolean): string {
  return unsupported ? "ratio-combo ratio-unsupported" : "ratio-combo ";
}

/** 聚焦时填入输入框的文本：自动从空开始（手填即转手动），否则填当前宽高比。 */
export function ratioFocusText(spec: SizeSpec): string {
  return isAutoRatio(spec) ? "" : (spec.ratio ?? "");
}

/** 失焦提交要做的两件事：ratio = 要选的新宽高比（null = 值没变），hint = 越界钳制后的范围提示。 */
export interface RatioDraftCommit {
  ratio: string | null;
  hint: string | null;
}

/**
 * 失焦时手填文本 → 提交动作；null = 什么都不提交（没改过、刚选了列表项、或文本读不出）。
 * 没改过 = 与聚焦时填入的文本相同：越界的「（不支持）」值点一下不会被钳制。
 */
export function commitRatioDraft(rule: SizeRule, spec: SizeSpec, draft: string | null, initial: string, discard: boolean): RatioDraftCommit | null {
  if (draft === null || draft === initial || discard) return null;
  const result = commitRatioInput(rule, draft);
  if (result === null) return null;
  const changed = isAutoRatio(spec) || result.ratio !== spec.ratio;
  return { ratio: changed ? result.ratio : null, hint: result.clamped ? `该模型宽高比范围 ${ratioRangeText(rule)}` : null };
}

/** 选中列表项是否要改宽高比：选中当前状态（已经是自动 / 同一个宽高比）时不动。 */
export function ratioPickChanges(value: string, spec: SizeSpec): boolean {
  const isAuto = isAutoRatio(spec);
  return value === AUTO_RATIO ? !isAuto : isAuto || value !== spec.ratio;
}

/** 预设项的文字：自动项在自动状态下显示推测标签，否则显示「自动」。 */
export function ratioPresetLabel(value: string, spec: SizeSpec, autoText: string): string {
  if (value !== AUTO_RATIO) return value;
  return isAutoRatio(spec) ? autoText : "自动";
}

/** 预设项是否选中。 */
export function ratioPresetSelected(value: string, spec: SizeSpec): boolean {
  if (value === AUTO_RATIO) return isAutoRatio(spec);
  return !isAutoRatio(spec) && value === spec.ratio;
}
