// 画板包 fixture（node-only）：manifest + 一块画板，导入用例用来验「选中的包文件被交给端口」。
// 单独成模块的原因：造 zip 要 node:zlib（crc32 / deflateRawSync），而内存壳端口
// （shell/testing/fakePort.ts）在浏览器 e2e 里也会被加载。夹具留在端口模块里时，
// vite 会把 node:zlib 外置，页面一 import 就整页白屏（2026-11-19 实测）。
// 所以：**浏览器安全的端口模块不碰 node: 内置模块，node-only 的夹具各归各的模块。**
import { buildZip, type FixtureEntry } from "./zipFixture";

/** 画板包 fixture：manifest + 一块画板。 */
export function fakePackFile(entries: FixtureEntry[] = []): File {
  const bytes = buildZip(entries);
  return new File([bytes as unknown as BlobPart], "包.ugcpack", { type: "application/zip" });
}
