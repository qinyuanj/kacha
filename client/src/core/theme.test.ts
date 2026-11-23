// @vitest-environment jsdom
// 主题核心（#221）：档位解析、系统档跟随、文档根应用与首帧镜像。
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_CHOICE,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  THEME_MIRROR_KEY,
  applyMirroredTheme,
  applyTheme,
  mirrorTheme,
  isThemeChoice,
  parseThemeChoice,
  readMirroredTheme,
  resolveEffectiveTheme,
  watchColorScheme,
  type ColorSchemeQuery,
  type ThemeStorage,
} from "./theme";

/** 内存里的本地存储替身：记下写入，也能按需抛错。 */
function memoryStorage(initial: Record<string, string> = {}, options: { throwOnWrite?: boolean } = {}) {
  const items = new Map(Object.entries(initial));
  const storage: ThemeStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (options.throwOnWrite) throw new Error("存储不可用");
      items.set(key, value);
    },
  };
  return { storage, items };
}

/** 宿主配色的媒体查询替身：测试自己触发 change，不依赖真实 matchMedia。 */
function fakeQuery(matches: boolean) {
  const listeners: ((event: { matches: boolean }) => void)[] = [];
  const query: ColorSchemeQuery = {
    matches,
    addEventListener: (_type, listener) => void listeners.push(listener),
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return {
    query,
    change(next: boolean) {
      for (const listener of listeners) listener({ matches: next });
    },
    listening: () => listeners.length,
  };
}

afterEach(() => {
  // 没有全局 setup：文档根上的主题属性由本文件的用例自己清掉，别污染后续用例。
  delete document.documentElement.dataset[THEME_ATTRIBUTE];
  document.documentElement.style.colorScheme = "";
});

describe("主题档位", () => {
  it("三档就是暗色 / 浅色 / 跟随系统，且默认暗色", () => {
    expect(THEME_CHOICES).toEqual(["dark", "light", "system"]);
    expect(DEFAULT_THEME_CHOICE).toBe("dark");
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("Dark")).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });

  it("合法值原样保留", () => {
    for (const choice of THEME_CHOICES) expect(parseThemeChoice(choice)).toBe(choice);
  });

  it("非法值（含缺失）回退默认暗色，不抛错", () => {
    for (const value of [undefined, null, "", "Dark", "auto", 1, {}, []]) {
      expect(parseThemeChoice(value), String(value)).toBe(DEFAULT_THEME_CHOICE);
    }
  });

  it("跟随系统档由宿主配色偏好解析成有效主题", () => {
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
    expect(resolveEffectiveTheme("system", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", false)).toBe("light");
  });
});

describe("文档根上的主题", () => {
  it("applyTheme 同时写 data-theme 与 color-scheme", () => {
    applyTheme(document.documentElement, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    applyTheme(document.documentElement, "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("首帧镜像", () => {
  it("镜像只写档位，键只有一处定义", () => {
    const { storage, items } = memoryStorage();
    mirrorTheme(storage, "system");
    expect(THEME_MIRROR_KEY).toBe("kacha.theme");
    expect(items.get(THEME_MIRROR_KEY)).toBe("system");
    expect(readMirroredTheme(storage)).toBe("system");
  });

  it("没写过、被写坏或存储不可用时都按默认暗色", () => {
    expect(readMirroredTheme(memoryStorage().storage)).toBe("dark");
    expect(readMirroredTheme(memoryStorage({ [THEME_MIRROR_KEY]: "bogus" }).storage)).toBe("dark");
    expect(readMirroredTheme(null)).toBe("dark");
    const broken: ThemeStorage = {
      getItem: () => {
        throw new Error("存储不可用");
      },
      setItem: () => undefined,
    };
    expect(readMirroredTheme(broken)).toBe("dark");
  });

  it("写不进去也不影响本次会话", () => {
    const { storage, items } = memoryStorage({}, { throwOnWrite: true });
    expect(() => mirrorTheme(storage, "light")).not.toThrow();
    expect(items.size).toBe(0);
  });

  it("挂载前按镜像与宿主偏好把有效主题写到文档根", () => {
    const { storage } = memoryStorage({ [THEME_MIRROR_KEY]: "system" });
    expect(applyMirroredTheme(document.documentElement, storage, true)).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});

describe("宿主配色媒体查询", () => {
  it("订阅后只把 matches 交给回调，取消订阅后不再回调", () => {
    const fake = fakeQuery(false);
    const seen: boolean[] = [];
    const off = watchColorScheme(fake.query, (prefersDark) => seen.push(prefersDark));
    fake.change(true);
    fake.change(false);
    expect(seen).toEqual([true, false]);
    off();
    expect(fake.listening()).toBe(0);
  });

  it("没有媒体查询（node 环境）时订阅是空操作", () => {
    const seen: boolean[] = [];
    const off = watchColorScheme(null, (prefersDark) => seen.push(prefersDark));
    expect(typeof off).toBe("function");
    expect(seen).toEqual([]);
    off();
  });
});
