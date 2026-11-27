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

describe("浅色画布配色与连线边界", () => {
  it("画布使用反馈指定的 #dedeba，各连线对画布至少 3:1", () => {
    const canvasBg = lightToken("--canvas-bg")
    expect(canvasBg).toBe("#dedeba")
    for (const name of ["--port-image", "--port-positive", "--port-negative", "--edge-system"]) {
      const colour = lightToken(name)
      expect(contrastOf(colour, canvasBg), `${name} ${colour} 对米色画布 ${canvasBg} 的对比度不足 3:1`).toBeGreaterThanOrEqual(3)
    }
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


/* ---- 框选遮罩契约（浅色下曾整块挡住节点）--------------------------------------
 * .react-flow__selection（拖拽框选矩形）与 .react-flow__nodesselection-rect（选中框）
 * 都按 canvas.css:22 的 --xy-selection-background-color 上色，真源是 tokens.css 的
 * --rf-selection-bg。两个矩形都画在节点之上：填充不透明时，框下的节点等于被整块抹掉
 * （浅色旧值 #ddf4ff：节点文字 #1f2328 在框内变成 #ddf4ff，与同一层框选下的空白画布
 * 完全不可区分）。所以有两条必须能失败的断言：
 *   1. 按 tokens.css 的真实级联把 --rf-selection-bg 解析到底，最终颜色的 alpha 必须在
 *      0 与 1 之间——不透明会遮住内容，全透明会让框选区域看不见；
 *   2. 两套主题都从同一枚 --selection-fill 取色（颜色只定义一处，域模块只引用变量）。
 * 解析走级联而不是切字符串：--selection-fill 追加在文件末尾的「补充」小节，位置在两套
 * 主题的别名之后，按出现位置切片会取错块。
 */
interface TokenRule {
  selector: string;
  body: string;
}

function tokenRules(): TokenRule[] {
  const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((hit) => ({ selector: hit[1].trim(), body: hit[2] }));
}

/** 一条 :root 级规则在哪些主题下生效：裸 :root 两套都算，带 data-theme 的只算自己那套。 */
function themesOf(selector: string): ("dark" | "light")[] {
  const themes = new Set<"dark" | "light">();
  for (const one of selector.split(",")) {
    const part = one.trim();
    if (!part.startsWith(":root")) continue;
    if (part.includes('[data-theme="light"]')) themes.add("light");
    else if (part.includes('[data-theme="dark"]')) themes.add("dark");
    else {
      themes.add("dark");
      themes.add("light");
    }
  }
  return [...themes];
}

/** 按源码顺序累加某主题下生效的 :root 自定义属性：后者覆盖前者，即真实级联。 */
function tokensFor(theme: "dark" | "light"): Map<string, string> {
  const declared = new Map<string, string>();
  for (const rule of tokenRules()) {
    if (!themesOf(rule.selector).includes(theme)) continue;
    for (const hit of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) declared.set(hit[1], hit[2].trim());
  }
  return declared;
}

/** 顺着 var(--x) 引用解析到底（最多 8 跳：写错自引用时失败而不是死循环）。 */
function resolveToken(declared: Map<string, string>, name: string, depth = 0): string {
  const value = declared.get(name);
  if (value === undefined) throw new Error("主题里没有 " + name);
  if (depth > 8) throw new Error(name + " 的 var() 引用太深或自引用");
  const reference = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return reference ? resolveToken(declared, reference[1], depth + 1) : value;
}

/** CSS 颜色的 alpha：#rrggbb / rgb() 视为 1，带 / 0.12 或 / 12% 的按字面算。 */
function alphaOf(colour: string): number {
  if (colour.startsWith("#")) return colour.length === 9 ? parseInt(colour.slice(7, 9), 16) / 255 : 1;
  const slash = colour.match(/\/\s*([\d.]+)(%)?/);
  if (!slash) return 1;
  const amount = Number(slash[1]);
  return slash[2] === "%" ? amount / 100 : amount;
}

describe("框选遮罩半透明契约（浅色下整块挡住节点）", () => {
  for (const theme of ["dark", "light"] as const) {
    it(theme + "：--rf-selection-bg 解析出的 alpha 在 0 与 1 之间", () => {
      const resolved = resolveToken(tokensFor(theme), "--rf-selection-bg");
      const alpha = alphaOf(resolved);
      expect(
        alpha,
        theme + " 的框选填充解析为 " + resolved + "：不透明会把框下的节点整块抹掉（遮罩画在节点之上）",
      ).toBeLessThan(1);
      expect(alpha, theme + " 的框选填充解析为 " + resolved + "：alpha 为 0 时框选区域完全看不见").toBeGreaterThan(0);
    });
  }

  it("两套主题都从同一个 --selection-fill 取色（改色只改一处）", () => {
    for (const theme of ["dark", "light"] as const) {
      expect(
        tokensFor(theme).get("--rf-selection-bg"),
        theme + " 的框选填充必须引用 --selection-fill，不要在主题块里另写色号",
      ).toBe("var(--selection-fill)");
    }
  });
});

/* ---- 框选虚线描边对比度契约（#247，WCAG 1.4.11）--------------------------------
 * 浅色主题的框选矩形先铺 --selection-fill，再画 1px 虚线描边（canvas.css:23 的
 * --xy-selection-border）。描边压在填充上必须 ≥3:1，否则框选边界只能靠填充辨认。
 * 期望值由本文件独立算出：按 tokens.css 的级联把两枚 token 解析到底，把半透明填充
 * 叠到画布底色上得到真实像素，再走 WCAG 2.1 相对亮度公式——不读取实现侧的任何
 * 颜色计算（样式侧本来也没有），所以色值被改回低对比度时这条断言会真的红。
 */
function channelsOf(colour: string): { rgb: [number, number, number]; alpha: number } {
  if (colour.startsWith("#")) {
    const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16)) as [number, number, number];
    return { rgb, alpha: alphaOf(colour) };
  }
  const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).map(Number);
  return { rgb: [r, g, b], alpha: alphaOf(colour) };
}

/** 半透明颜色叠到不透明底色后的实际像素，返回 #rrggbb。 */
function over(colour: string, backdrop: string): string {
  const front = channelsOf(colour);
  const back = channelsOf(backdrop);
  const mixed = front.rgb.map((channel, i) => Math.round(front.alpha * channel + (1 - front.alpha) * back.rgb[i]));
  return "#" + mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("");
}

describe("框选虚线描边对比度契约（#247）", () => {
  it("浅色下描边对框选填充至少 3:1，暗色描边保持原值", () => {
    const light = tokensFor("light");
    // 框选矩形先铺半透明填充、再画描边：先叠到画布底色上，得到描边实际压着的像素。
    const fill = over(resolveToken(light, "--selection-fill"), resolveToken(light, "--canvas-bg"));
    const border = resolveToken(light, "--rf-selection-border");
    expect(
      contrastOf(border, fill),
      "浅色框选描边 " + border + " 对框选填充 " + fill + " 的对比度不足 3:1（WCAG 1.4.11）",
    ).toBeGreaterThanOrEqual(3);

    // 暗色框选描边在暗底上本来就够可见：这条边必须与修复前逐字相同。
    expect(resolveToken(tokensFor("dark"), "--rf-selection-border")).toBe("rgb(76 141 255 / 50%)");
  });
});
