// 画布覆盖层的接线参数（#223）：色彩模式随有效主题走，颜色一律指向 tokens 的 --rf-* 映射，
// 具体色号由 data-theme 解析（一个含义只定义一处：色号在 styles/tokens.css，这里只有引用）。
// 精确的属性清单只在 BoardCanvas.test 断言一次；这里只测「主题怎样影响接线」这一个契约。
import { describe, expect, it } from "vitest";
import { canvasThemeProps } from "./canvasTheme";

describe("画布主题接线", () => {
  it("有效主题决定交给 React Flow 的色彩模式", () => {
    expect(canvasThemeProps("dark").colorMode).toBe("dark");
    expect(canvasThemeProps("light").colorMode).toBe("light");
  });

  it("除色彩模式外，两套主题的接线完全相同：换色只发生在样式侧", () => {
    expect({ ...canvasThemeProps("light"), colorMode: null }).toEqual({ ...canvasThemeProps("dark"), colorMode: null });
  });
});
