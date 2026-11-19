// 主界面更新提示条的可见判定与文案（#180）：与 updateSectionView 一样是纯逻辑，组件只摆放 DOM。
import { autoInstallText, type AutoInstallView } from "../core/updateAutoInstall";
import type { UpdatePhase, UpdateSnapshot } from "../core/update";

/** 主界面显示更新提示条的阶段：发现、下载中、已就绪、正在装；其余阶段不打扰。 */
const VISIBLE_PHASES: ReadonlySet<UpdatePhase> = new Set(["available", "downloading", "ready", "installing"]);

/** 提示条此刻的样子。 */
export interface UpdateStatusView {
  /** 要不要显示：只有发现 / 下载中 / 已就绪 / 正在装时显示。 */
  visible: boolean;
  /** 阶段：作为 data 属性给样式与诊断用。 */
  phase: UpdatePhase;
  /** 提示条那一句话。 */
  text: string;
  /** 给不给「稍后」：只有倒计时期间才有可推迟的事。 */
  canDefer: boolean;
}

export function updateStatusView(input: { snapshot: UpdateSnapshot; auto: AutoInstallView }): UpdateStatusView {
  const { snapshot, auto } = input;
  return {
    visible: VISIBLE_PHASES.has(snapshot.phase),
    phase: snapshot.phase,
    text: autoInstallText(auto, snapshot),
    canDefer: auto.counting,
  };
}
