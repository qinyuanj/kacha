// 区域指示紫（#218）：core/overlay.ts 的 REGION_COLORS 是契约真源，styles/tokens.css 是同一契约的
// 样式侧写法。两处逐字一致，屏幕上看到的颜色才等于发给模型的颜色指代；色值是规格硬约束，这里只校验不改值。
// 只读 tokens.css 里的字面量（不断言选择器）：vitest 默认把 CSS 模块折成空串，?raw 拿不到原文，
// 所以按 index.test.ts 的既有做法直接读文件。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGION_COLORS } from "../core/overlay";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** 区域1 的紫：overlay.ts 里 REGION_COLORS 的第一个色。 */
const [r, g, b] = REGION_COLORS[0].rgb;

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
