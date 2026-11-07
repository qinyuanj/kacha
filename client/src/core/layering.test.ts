// 分层守护：core 是纯业务模块，生产代码只依赖 core 自身与 npm 包，不依赖 shell / ui / e2e。
// 壳层能力经端口（参数）注入；core 需要的错误语义按结构读（如 status），不导入壳层的类。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const coreDir = path.dirname(fileURLToPath(import.meta.url));

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "testing" || e.name === "__fixtures__" ? [] : productionFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

it("core 生产代码只导入 core 内部与 npm 包", () => {
  const outside = productionFiles(coreDir).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(SPECIFIER)]
      .map((m) => m[1])
      .filter((spec) => spec.startsWith("."))
      .filter((spec) => path.relative(coreDir, path.resolve(path.dirname(file), spec)).startsWith(".."))
      .map((spec) => `${path.relative(coreDir, file)} -> ${spec}`),
  );
  expect(outside).toEqual([]);
});
