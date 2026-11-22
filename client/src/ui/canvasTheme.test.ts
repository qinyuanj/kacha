// 画布覆盖层的接线参数（#223）：色彩模式随有效主题走，颜色一律指向 tokens 的 --rf-* 映射，
// 具体色号由 data-theme 解析（一个含义只定义一处：色号在 styles/tokens.css，这里只有引用）。
import { describe, expect, it } from "vitest";
import { canvasThemeProps } from "./canvasTheme";

describe("画布主题接线", () => {
  it("有效主题决定交给 React Flow 的色彩模式", () => {
    expect(canvasThemeProps("dark").colorMode).toBe("dark");
    expect(canvasThemeProps("light").colorMode).toBe("light");
  });

  it("点阵背景显式给间距与点径，底色与点色指向画布 tokens", () => {
    expect(canvasThemeProps("light").background).toEqual({
      gap: 20,
      size: 1.2,
      color: "var(--rf-dot)",
      bgColor: "var(--rf-background)",
    });
  });

  it("两套主题指向同一组背景 token：换色只发生在样式侧，接线不跟着变", () => {
    expect(canvasThemeProps("light").background).toEqual(canvasThemeProps("dark").background);
  });

  it("迷你地图可平移缩放，底色、遮罩与节点方块色按 token 取", () => {
    expect(canvasThemeProps("light").minimap).toEqual({
      pannable: true,
      zoomable: true,
      bgColor: "var(--rf-minimap-bg)",
      maskColor: "var(--rf-minimap-mask)",
      nodeColor: "var(--rf-minimap-node)",
    });
  });
});
