// 顶栏主题切换入口的文案（#221）：与界面无关的无依赖模块（CODING_STANDARDS「一个含义只定义一处」）。
import type { ThemeChoice } from "../core/theme";

/** 三档的显示名：规格用语就是这三个，别另起同义词。 */
export const THEME_LABELS: Record<ThemeChoice, string> = {
  dark: "暗色",
  light: "浅色",
  system: "跟随系统",
};

/** 分段控件这一组的可访问名。 */
export const THEME_GROUP_LABEL = "主题";

/** 单个档位的悬浮说明：点了会怎样。 */
export function themeOptionTitle(choice: ThemeChoice): string {
  return choice === "system" ? "跟随系统外观切换" : `始终使用${THEME_LABELS[choice]}`;
}
