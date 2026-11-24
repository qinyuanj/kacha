// 顶栏主题切换入口的文案（#221）：与界面无关的无依赖模块（CODING_STANDARDS「一个含义只定义一处」）。
import type { ThemeChoice } from "../core/theme";

/** 三档的显示名：规格用语就是这三个，别另起同义词。 */
export const THEME_LABELS: Record<ThemeChoice, string> = {
  dark: "暗色",
  light: "浅色",
  system: "跟随系统",
};

