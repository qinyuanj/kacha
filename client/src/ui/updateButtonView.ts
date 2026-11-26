// 单一版本入口的样子（#269）：文案固定为当前安装版本，颜色与状态由更新阶段决定。
//
// 纯逻辑，不碰 DOM。候选版本只出现在状态说明里，不替换按钮上的当前版本。
// 绿 = 已是最新；红 = 可推进或正在推进更新；其余阶段普通色。
import { updateText, type UpdateSnapshot } from "../core/update";

/** 版本入口的色调。 */
export type UpdateButtonTone = "neutral" | "latest" | "action";

/** 版本入口此刻的样子。 */
export interface UpdateButtonView {
  /** 按钮上的字：当前安装版本。 */
  label: string;
  /** 色调：组件据此选样式类。 */
  tone: UpdateButtonTone;
  /** 悬浮提示与无障碍名称里的状态说明。 */
  status: string;
}

const UPDATE_ENABLED_TEXT = "自动更新尚不可用";

/** 每个阶段的色调。 */
const TONE: Record<UpdateSnapshot["phase"], UpdateButtonTone> = {
  disabled: "neutral",
  idle: "neutral",
  checking: "neutral",
  up_to_date: "latest",
  available: "action",
  downloading: "action",
  ready: "action",
  installing: "action",
  error: "neutral",
};

/** 版本入口此刻的样子：版本不变，状态与色调按阶段给出。 */
export function updateButtonView(
  snapshot: UpdateSnapshot,
  currentVersion: string,
  updateEnabled: boolean,
): UpdateButtonView {
  return {
    label: currentVersion,
    tone: updateEnabled ? TONE[snapshot.phase] : "neutral",
    status: updateEnabled ? updateText(snapshot) : UPDATE_ENABLED_TEXT,
  };
}
