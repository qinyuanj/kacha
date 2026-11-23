// 区域指示紫（#218）：core/overlay.ts 的 REGION_COLORS 是契约真源，styles/tokens.css 是同一契约的
// 样式侧写法。两处逐字一致，屏幕上看到的颜色才等于发给模型的颜色指代；色值是规格硬约束，这里只校验不改值。
// 只读 tokens.css 里的字面量（不断言选择器）：vitest 默认把 CSS 模块折成空串，?raw 拿不到原文，
// 所以按 index.test.ts 的既有做法直接读文件。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGION_COLORS } from "../core/overlay";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const canvas = readFileSync(new URL("./canvas.css", import.meta.url), "utf8");

/** WCAG 2.1 相对亮度；期望值由公式独立算出，不复用被测代码里的任何色值处理。 */
function contrastOf(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

function lightToken(name: string): string {
  const light = tokens.slice(tokens.indexOf('[data-theme="light"]'))
  const hit = light.match(new RegExp(`\\s${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!hit) throw new Error(`浅色主题没有 ${name}`)
  return hit[1]
}

/** 区域1 的紫：overlay.ts 里 REGION_COLORS 的第一个色。 */
const [r, g, b] = REGION_COLORS[0].rgb;

describe("Light Studio 未选中节点卡片的边界契约（#226）", () => {
  it("浅色卡片描边对画布底至少 3:1，且未选中态用它", () => {
    const border = lightToken("--border-3")
    const canvasBg = lightToken("--canvas-bg")
    expect(contrastOf(border, canvasBg)).toBeGreaterThanOrEqual(3)

    // 警告 / 错误态有自己的 2px 彩色边框，不该被这条覆盖。
    expect(
      canvas.includes(':root[data-theme="light"] .node:not(.node-warn):not(.node-error)'),
      "浅色未选中节点卡片的描边覆盖规则缺失",
    ).toBe(true)
    expect(canvas.match(/border-color: var\(--border-3\)/g)?.length).toBeGreaterThanOrEqual(1)
  })
})

describe("内联危险色文字契约（#242）", () => {
  it("浅色用 --danger-text 达到 4.5:1，暗色仍解析到 --danger，观感不变", () => {
    expect(contrastOf(lightToken("--danger-text"), lightToken("--surface"))).toBeGreaterThanOrEqual(4.5)
    expect(
      [...canvas.matchAll(/^\s*color:\s*var\(--danger\);/gm)],
      "canvas 层还有文字色直接用 --danger，浅色对比度不达标",
    ).toEqual([])

    const dark = tokens.slice(0, tokens.indexOf('[data-theme="light"]'))
    expect(dark, "暗色内联危险文字必须沿用 --danger").toMatch(/--danger-inline-text:\s*var\(--danger\)/);
    expect(tokens.slice(tokens.indexOf('[data-theme="light"]')), "浅色内联危险文字必须用 --danger-text")
      .toMatch(/--danger-inline-text:\s*var\(--danger-text\)/);
  })
})

describe("区域指示紫的契约", () => {
  it("tokens.css 的紫与 REGION_COLORS 的第一个 RGB 逐字相同", () => {
    // 两种不透明度：区域指示本身（90%）与合成参考图时的高亮混合（50%）。
    for (const alpha of ["90%", "50%"]) {
      const literal = `rgb(${r} ${g} ${b} / ${alpha})`;
      expect(
        tokens.includes(literal),
        `tokens.css 里没有 ${literal}：它与 core/overlay.ts 的 REGION_COLORS 是同一契约的两处写法（改了色号必须两边一起改）`,
      ).toBe(true);
    }
  });
});
