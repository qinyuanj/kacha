// 画布覆盖层的接线参数（#223）：画布怎么把当前主题交给 React Flow。
//
// 只有色彩模式是「随主题变的 props」；点阵背景、迷你地图的颜色全是指向 styles/tokens.css
// 里 --rf-* 映射的引用，换主题时由 data-theme 在样式侧解析，接线不重算色号。
// 判定收在这里（不塞进 BoardCanvas），画布只展开给 React Flow。
import type { EffectiveTheme } from "../core/theme";

/** 点阵背景：间距与点径是形状，不随主题；颜色是 token 引用。 */
export interface CanvasBackgroundProps {
  gap: number;
  size: number;
  color: string;
  bgColor: string;
}

/** 迷你地图：可平移缩放，遮罩与节点方块同样是 token 引用。 */
export interface CanvasMinimapProps {
  pannable: true;
  zoomable: true;
  bgColor: string;
  maskColor: string;
  maskStrokeColor: string;
  maskStrokeWidth: number;
  nodeColor: string;
}

export interface CanvasThemeProps {
  colorMode: EffectiveTheme;
  background: CanvasBackgroundProps;
  minimap: CanvasMinimapProps;
}

const DOT_GAP = 20;
const DOT_SIZE = 1.2;

const BACKGROUND: CanvasBackgroundProps = {
  gap: DOT_GAP,
  size: DOT_SIZE,
  color: "var(--rf-dot)",
  bgColor: "var(--rf-background)",
};

const MINIMAP: CanvasMinimapProps = {
  pannable: true,
  zoomable: true,
  bgColor: "var(--rf-minimap-bg)",
  maskColor: "var(--rf-minimap-mask)",
  maskStrokeColor: "var(--rf-controls-border)",
  maskStrokeWidth: 1,
  nodeColor: "var(--rf-minimap-node)",
};

/** 有效主题 → React Flow 的色彩模式与背景 / 迷你地图配置。 */
export function canvasThemeProps(theme: EffectiveTheme): CanvasThemeProps {
  return { colorMode: theme, background: BACKGROUND, minimap: MINIMAP };
}
