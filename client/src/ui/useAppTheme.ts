// 工作台的主题接线（#221）：App 里只留 useAppTheme 这一次调用。
//
// 三件事都收在这里，App 不必知道细节：
//   saved    —— 设置读到之前为 null，先按首帧镜像显示；读到后以设置真源为准。
//   syncNative —— 把档位通知宿主壳（原生标题栏与窗口底色），失败不阻塞切换。
//   persist  —— 写回设置文件；能不能落盘由 useSettings.setTheme 按 mayOverwriteSettings 判定。
import type { ThemeChoice } from "../core/theme";
import { useTheme, type ThemeControl } from "./useTheme";

/** 主题接线需要的设置与壳端口（结构性类型，便于测试替身）。 */
export interface AppThemeInput {
  settings: {
    readonly loaded: boolean;
    readonly settings: { readonly theme: ThemeChoice };
    setTheme(choice: ThemeChoice): void;
  };
  ui: { setNativeTheme(choice: ThemeChoice): Promise<void> };
}

export function useAppTheme({ settings, ui }: AppThemeInput): ThemeControl {
  return useTheme({
    saved: settings.loaded ? settings.settings.theme : null,
    syncNative: (choice) => ui.setNativeTheme(choice),
    persist: (choice) => void settings.setTheme(choice),
  });
}
