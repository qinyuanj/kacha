// 样式分层（#221）：五个模块由入口按固定顺序引入，顺序就是层叠优先级。
// knip 不追踪 CSS：漏一个 @import 页面不会报错，只会少一层样式，所以这里钉住「谁在、顺序对不对」。
// 模块清单只写这一处，顺序断言与真实入口逐项比较；不断言任何具体规则文本。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MODULES = ["./tokens.css", "./base.css", "./shell.css", "./canvas.css", "./dialogs.css"];

describe("样式分层", () => {
  it("入口按 tokens → base → shell → canvas → dialogs 的顺序引入五个模块", () => {
    const entry = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const imported = [...entry.matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
    // 逐项相等同时管两件事：五个模块一个不少，顺序也没被打乱。
    expect(imported).toEqual(MODULES);
  });
});
