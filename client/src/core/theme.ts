// 主题真源（#221）：档位（暗色 / 浅色 / 跟随系统）与有效主题（暗色 / 浅色）是两件事。
//
// 解析、首帧镜像与「写到文档根」都在这里；React 状态在 ui/useTheme.ts、入口文案在 ui/themeText.ts。
// 样式侧的 tokens 按 :root[data-theme="dark"|"light"] 分支，两个地方共用 THEME_ATTRIBUTE 这一个属性名。

/** 用户选的档位。 */
export type ThemeChoice = "dark" | "light" | "system";

/** 实际画到界面上的主题：档位为 system 时由宿主配色媒体查询解析。 */
export type EffectiveTheme = "dark" | "light";

/** 三档的固定顺序：顶栏入口按它排，解析与文案共用同一份。 */
export const THEME_CHOICES: readonly ThemeChoice[] = ["dark", "light", "system"];

/** 未配置（settings.json 没有 theme、镜像读不到）时的产品默认：Dark Studio。 */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "dark";

/** 文档根节点上的主题属性名：样式用 :root[data-theme="dark"|"light"] 选 tokens。 */
export const THEME_ATTRIBUTE = "theme";

/** 首帧镜像在浏览器本地存储里的键（唯一一处定义）。 */
export const THEME_MIRROR_KEY = "kacha.theme";

/** 宿主配色媒体查询：与有效主题的「跟随系统」档同源。 */
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "dark" || value === "light" || value === "system";
}

/** 任意输入 → 合法档位；非法（含缺失）回退产品默认暗色，不抛错，也不影响其它设置字段。 */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return isThemeChoice(value) ? value : DEFAULT_THEME_CHOICE;
}

/** 档位 + 宿主配色偏好 → 有效主题。 */
export function resolveEffectiveTheme(choice: ThemeChoice, systemPrefersDark: boolean): EffectiveTheme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
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

/** 读首帧镜像的档位：没写过、被写坏或存储不可用时都按产品默认。 */
export function readMirroredTheme(storage: ThemeStorage | null): ThemeChoice {
  try {
    return parseThemeChoice(storage?.getItem(THEME_MIRROR_KEY));
  } catch {
    return DEFAULT_THEME_CHOICE;
  }
}

/**
 * 写首帧镜像。只存档位、不存有效主题——「跟随系统」档每次启动都要重新问一次系统。
 * 写不进去不影响本次会话（界面已按内存档位生效）。
 */
export function mirrorTheme(storage: ThemeStorage | null, choice: ThemeChoice): void {
  try {
    storage?.setItem(THEME_MIRROR_KEY, choice);
  } catch {
    // 存储是首帧优化的旁路：失败就退回「首帧按默认暗色、设置读到后再校正」。
  }
}

/**
 * 首帧：在 React 挂载前同步按镜像档位解析出有效主题写到文档根，消除反向主题闪跳。
 * 返回镜像里的档位（界面用它做初始按下态，设置读到后以设置真源为准）。
 */
export function applyMirroredTheme(root: HTMLElement, storage: ThemeStorage | null, systemPrefersDark: boolean): ThemeChoice {
  const choice = readMirroredTheme(storage);
  applyTheme(root, resolveEffectiveTheme(choice, systemPrefersDark));
  return choice;
}

/** 宿主配色媒体查询的最小形状：真实 MediaQueryList 与测试注入都满足它。 */
export interface ColorSchemeQuery {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener?(type: "change", listener: (event: { matches: boolean }) => void): void;
}

/** 文档的配色媒体查询；环境没有 matchMedia 时为 null（按浅色处理）。 */
export function colorSchemeQuery(): ColorSchemeQuery | null {
  return typeof globalThis.matchMedia === "function" ? (globalThis.matchMedia(DARK_SCHEME_QUERY) as ColorSchemeQuery) : null;
}

/** 订阅系统配色变化，返回取消订阅函数；查询不支持事件时什么都不发生。 */
export function watchColorScheme(query: ColorSchemeQuery | null, onChange: (prefersDark: boolean) => void): () => void {
  const listener = (event: { matches: boolean }) => onChange(event.matches);
  if (!query?.addEventListener) return () => undefined;
  query.addEventListener("change", listener);
  return () => query.removeEventListener?.("change", listener);
}
