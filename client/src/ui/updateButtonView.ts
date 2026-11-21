// 首页版本号旁那个更新按钮的样子（#181）：文案与颜色跟着更新阶段走。
//
// 纯逻辑，不碰 DOM：组件只负责把这里的结果摆成按钮。
// 颜色语义与项目既有约定一致：绿 = 已是最新（与 .ok-text 同色），红 = 有事要做
// （与 --red 同色），其余阶段保持中性。
import { progressText, type UpdatePhase, type UpdateSnapshot } from "../core/update";

/** 按钮的色调。 */
export type UpdateButtonTone = "neutral" | "latest" | "action" | "bad";

/** 按钮此刻的样子。 */
export interface UpdateButtonView {
  /** 按钮上的字。 */
  label: string;
  /** 色调：组件据此选样式类。 */
  tone: UpdateButtonTone;
}

/** 每个阶段的文案。 */
const LABEL: Record<UpdatePhase, (snapshot: UpdateSnapshot) => string> = {
  disabled: () => "自动更新尚不可用",
  idle: () => "检查更新",
  checking: () => "检查中…",
  up_to_date: () => "已是最新",
  available: (s) => (s.version ? `有新版本 ${s.version}` : "有新版本"),
  downloading: (s) => `下载中${progressText(s)}`,
  ready: (s) => (s.version ? `新版本 ${s.version} 就绪` : "新版本就绪"),
  installing: () => "安装中…",
  error: () => "检查失败",
};

/** 每个阶段的色调。 */
const TONE: Record<UpdatePhase, UpdateButtonTone> = {
  disabled: "neutral",
  idle: "neutral",
  checking: "neutral",
  up_to_date: "latest",
  available: "action",
  downloading: "neutral",
  ready: "action",
  installing: "neutral",
  error: "bad",
};

/** 按钮此刻的样子：文案与色调都跟着阶段走。 */
export function updateButtonView(snapshot: UpdateSnapshot): UpdateButtonView {
  const label = LABEL[snapshot.phase];
  const tone = TONE[snapshot.phase];
  return {
    label: label ? label(snapshot) : LABEL.error(snapshot),
    tone: tone ?? "neutral",
  };
}
