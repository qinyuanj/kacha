// 主题真源（#265）：只有暗色 / 浅色两态；旧 system 在读取边界迁为浅色。
//
// 解析、首帧镜像与「写到文档根」都在这里；React 状态在 ui/useTheme.ts、入口文案在 ui/themeText.ts。
// 样式侧的 tokens 按 :root[data-theme="dark"|"light"] 分支，两个地方共用 THEME_ATTRIBUTE 这一个属性名。

/** 用户选的固定档位。 */
export type ThemeChoice = "dark" | "light";

/** 有效主题与档位同义：没有系统跟随第三态。 */
export type EffectiveTheme = "dark" | "light";

/** 未配置（settings.json 没有 theme、镜像读不到）时的产品默认：浅色。 */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "light";

/** 文档根节点上的主题属性名：样式用 :root[data-theme="dark"|"light"] 选 tokens。 */
export const THEME_ATTRIBUTE = "theme";

/** 首帧镜像在浏览器本地存储里的键（唯一一处定义）。 */
export const THEME_MIRROR_KEY = "kacha.theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "dark" || value === "light";
}

/** 任意输入 → 合法档位；旧 system、非法（含缺失）回退产品默认浅色，不抛错。 */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return isThemeChoice(value) ? value : DEFAULT_THEME_CHOICE;
}

/**
 * 把有效主题写到文档根：data-theme 给样式选 tokens，color-scheme 让原生控件、
 * 滚动条与表单跟随（暗色下不再出现白底下拉框）。
 */
export function applyTheme(root: HTMLElement, theme: EffectiveTheme): void {
  root.dataset[THEME_ATTRIBUTE] = theme;
  root.style.colorScheme = theme;
}

/** 只读的本地存储接缝（浏览器的 localStorage 满足它）。 */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** 取浏览器本地存储；没有存储或被策略挡住（隐私模式、不透明 origin）时为 null。 */
export function themeStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读首帧镜像的档位：旧 system、没写过、写坏或存储不可用时都按浅色。 */
export function readMirroredTheme(storage: ThemeStorage | null): ThemeChoice {
  try {
    return parseThemeChoice(storage?.getItem(THEME_MIRROR_KEY));
  } catch {
    return DEFAULT_THEME_CHOICE;
  }
}

/**
 * 写首帧镜像：只存固定档位。失败不影响本次会话（界面已按内存档位生效）。
 */
export function mirrorTheme(storage: ThemeStorage | null, choice: ThemeChoice): void {
  try {
    storage?.setItem(THEME_MIRROR_KEY, choice);
  } catch {
    // 存储是首帧优化的旁路：失败就退回「首帧按默认浅色、设置读到后再校正」。
  }
}

/** 首帧：在 React 挂载前同步按镜像档位写到文档根，消除反向主题闪跳。 */
export function applyMirroredTheme(root: HTMLElement, storage: ThemeStorage | null): ThemeChoice {
  const choice = readMirroredTheme(storage);
  applyTheme(root, choice);
  return choice;
}
