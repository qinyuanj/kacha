// 更新面板的可见判定与文案（#164）：从 ui/UpdateSection.tsx 拆出的纯逻辑。
// 组件只留接线与 DOM 摆放。
import { canCheck, canInstall, progressText, updateText, type UpdateSnapshot } from "../core/update";

/** 面板此刻的样子：显示什么、哪些按钮能点。 */
export interface UpdateSectionView {
  /** 状态一句话。 */
  status: string;
  /** 检查按钮能不能点。 */
  canCheck: boolean;
  /** 安装按钮能不能点：已验签且服务说可装。 */
  canInstall: boolean;
  /** 进度百分比文案（下载中才有内容）。 */
  progress: string;
  /** 当前版本与可更新版本，供面板标题用。 */
  current: string;
  version: string;
  /** 正在准备（保存与等在途操作）：按钮要禁用并说明。 */
  preparing: boolean;
  /** 准备期间被拒绝的原因（任务未完成、保存失败）。 */
  prepareError: string;
}

export function updateSectionView(input: {
  snapshot: UpdateSnapshot;
  preparing: boolean;
  prepareError: string;
}): UpdateSectionView {
  const { snapshot } = input;
  return {
    status: updateText(snapshot),
    // 准备期间不能重复点检查：保存与等在途操作时不该再起网络动作。
    canCheck: canCheck(snapshot) && !input.preparing,
    canInstall: canInstall(snapshot) && !input.preparing,
    progress: progressText(snapshot),
    current: snapshot.current,
    version: snapshot.version,
    preparing: input.preparing,
    prepareError: input.prepareError,
  };
}
