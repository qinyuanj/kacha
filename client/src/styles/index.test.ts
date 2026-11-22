// 样式分层（#221）：五个模块都必须真实存在，并由入口按固定顺序引入。
// knip 不追踪 CSS：漏一个 import 页面不会报错，只会少一层样式，所以这里钉住「谁在、顺序对不对」。
// 只断言模块清单与引入顺序，不断言任何具体规则文本。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MODULES = ["tokens", "base", "shell", "canvas", "dialogs"];
const files = MODULES.map((name) => `./${name}.css`);

// 由打包器解析：路径写错时这个键就不存在（比手写 existsSync 更接近真实构建）。
const resolved = import.meta.glob("./*.css");

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

describe("样式分层", () => {
  it("五个模块都在（路径由打包器解析）", () => {
    expect(Object.keys(resolved).sort()).toEqual([...files, "./index.css"].sort());
  });

  it("入口按 tokens → base → shell → canvas → dialogs 的顺序引入", () => {
    const imported = [...source("./index.css").matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
    expect(imported).toEqual(files);
  });

  it("每个模块都真的带着规则", () => {
    for (const file of files) {
      const rules = source(file).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      expect(rules.length, file).toBeGreaterThan(100);
    }
  });
});
