// @vitest-environment jsdom
// 主题核心（#265）：只有暗色 / 浅色两态；旧 system 在读取与首帧镜像边界迁到浅色。
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_CHOICE,
  THEME_ATTRIBUTE,
  THEME_MIRROR_KEY,
  applyMirroredTheme,
  applyTheme,
  mirrorTheme,
  isThemeChoice,
  parseThemeChoice,
  readMirroredTheme,
  type ThemeStorage,
} from "./theme";

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

afterEach(() => {
  delete document.documentElement.dataset[THEME_ATTRIBUTE];
  document.documentElement.style.colorScheme = "";
});

describe("主题档位", () => {
  it("只有暗色 / 浅色两态，默认浅色", () => {
    expect(DEFAULT_THEME_CHOICE).toBe("light");
    expect(isThemeChoice("light")).toBe(true);
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("system")).toBe(false);
    expect(isThemeChoice("Dark")).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });

  it("合法值原样保留，显式深色不被迁移", () => {
    for (const choice of ["dark", "light"] as const) expect(parseThemeChoice(choice)).toBe(choice);
  });

  it("旧 system 与非法值（含缺失）都迁到浅色，不抛错", () => {
    for (const value of ["system", undefined, null, "", "Dark", "auto", 1, {}, []]) {
      expect(parseThemeChoice(value), String(value)).toBe("light");
    }
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
  it("镜像只写两态档位，键只有一处定义", () => {
    const { storage, items } = memoryStorage();
    mirrorTheme(storage, "dark");
    expect(THEME_MIRROR_KEY).toBe("kacha.theme");
    expect(items.get(THEME_MIRROR_KEY)).toBe("dark");
    expect(readMirroredTheme(storage)).toBe("dark");
  });

  it("没写过、被写坏或存储不可用时都按浅色", () => {
    expect(readMirroredTheme(memoryStorage().storage)).toBe("light");
    expect(readMirroredTheme(memoryStorage({ [THEME_MIRROR_KEY]: "bogus" }).storage)).toBe("light");
    expect(readMirroredTheme(null)).toBe("light");
    const broken: ThemeStorage = {
      getItem: () => {
        throw new Error("存储不可用");
      },
      setItem: () => undefined,
    };
    expect(readMirroredTheme(broken)).toBe("light");
  });

  it("旧 system 镜像在读取边界迁为浅色", () => {
    expect(readMirroredTheme(memoryStorage({ [THEME_MIRROR_KEY]: "system" }).storage)).toBe("light");
  });

  it("写不进去也不影响本次会话", () => {
    const { storage, items } = memoryStorage({}, { throwOnWrite: true });
    expect(() => mirrorTheme(storage, "light")).not.toThrow();
    expect(items.size).toBe(0);
  });

  it("挂载前按镜像档位把有效主题写到文档根，旧 system 镜像落浅色", () => {
    const legacy = memoryStorage({ [THEME_MIRROR_KEY]: "system" });
    expect(applyMirroredTheme(document.documentElement, legacy.storage)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    const dark = memoryStorage({ [THEME_MIRROR_KEY]: "dark" });
    expect(applyMirroredTheme(document.documentElement, dark.storage)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
