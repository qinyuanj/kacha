// 样式域归属契约（#224）：每条规则只在一个层里定义一次。归属错了会让「改 A 域却动了 B 域」的概率上升。
// 按 index.css 的固定顺序 tokens → base → shell → canvas → dialogs，读原文判定（vitest 把 CSS 折成空串）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layers = {
  base: readFileSync(new URL("./base.css", import.meta.url), "utf8"),
  shell: readFileSync(new URL("./shell.css", import.meta.url), "utf8"),
  canvas: readFileSync(new URL("./canvas.css", import.meta.url), "utf8"),
  dialogs: readFileSync(new URL("./dialogs.css", import.meta.url), "utf8"),
} as const;

type Layer = keyof typeof layers;

/** 去掉注释，避免注释里的类名被当成定义。 */
function definitions(source: string, selector: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = new RegExp(`\\.${selector}\\s*[,{]`, "g");
  return [...code.matchAll(pattern)].length;
}

const ownership: { selector: string; owner: Layer }[] = [
  { selector: "badge-warn", owner: "base" },
  { selector: "error-list", owner: "base" },
  { selector: "warn-list", owner: "base" },
  { selector: "hint-list", owner: "base" },
  { selector: "icon-button", owner: "base" },
  { selector: "region-limit-exceeded", owner: "dialogs" },
  { selector: "tab-list", owner: "shell" },
  { selector: "field-label", owner: "canvas" },
  { selector: "form-row-label", owner: "dialogs" },
];

describe("样式规则的唯一归属层（#224）", () => {
  for (const { selector, owner } of ownership) {
    it(`.${selector} 只在 ${owner} 层定义一次`, () => {
      const counts = Object.fromEntries(
        (Object.keys(layers) as Layer[]).map((layer) => [layer, definitions(layers[layer], selector)]),
      ) as Record<Layer, number>;
      expect(counts[owner], `.${selector} 在 ${owner} 层的定义数`).toBeGreaterThanOrEqual(1);
      for (const layer of Object.keys(layers) as Layer[]) {
        if (layer !== owner) expect(counts[layer], `.${selector} 不该在 ${layer} 层`).toBe(0);
      }
    });
  }
});