// MyGo 桌面壳配置（#127）：Go 应用在 desktop/，前端仍是现有 client/，构建产物在 build/。
// 这里导出普通对象而不是 defineConfig({...})：CLI 用 Node 求值本文件，不引入额外依赖就能读。
// 版本、名称与标识符只在本文件定义。version 是产品版本号，必须与 server/Cargo.toml 同号：
// packaging/release_gate.py 读这两张清单比对，桌面打包入口经它取版本（ADR 0024）。
export default {
  name: "Kacha",
  slug: "kacha",
  identifier: "app.kacha.desktop",
  version: "1.5.0",
  // 相对仓库根；"desktop" 会被 go list 当成标准库包名，必须带 ./。
  main: "./desktop",
  // 构建前先构建现有前端；frontendDist 随后被嵌进可执行文件。
  buildCommand: "npm --prefix client run build",
  frontendDist: "client/dist",
  bindings: "client/src/mygo.ts",
  out: "build",
};
