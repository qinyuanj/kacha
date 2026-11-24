// MyGo 桌面壳配置（#127）：Go 应用在 desktop/，前端仍是现有 client/，构建产物在 build/。
// 这里导出普通对象而不是 defineConfig({...})：CLI 用 Node 求值本文件，不引入额外依赖就能读。
// 版本、名称与标识符只在本文件定义；packaging/release_gate.py 从这里读取产品版本号。
export default {
  name: "Kacha",
  slug: "kacha",
  identifier: "app.kacha.desktop",
  version: "1.7.0",
  // 相对仓库根；"desktop" 会被 go list 当成标准库包名，必须带 ./。
  main: "./desktop",
  // 构建前先构建现有前端；frontendDist 随后被嵌进可执行文件。
  buildCommand: "npm --prefix client run build",
  frontendDist: "client/dist",
  bindings: "client/src/mygo.ts",
  out: "build",
  // 安装器钩子：/S 静默安装不显示完成页，MyGo 自带的「运行 Kacha」勾选框
  // 不会出现，自动更新装完就停在那里。installer/installer.nsh 让安装器在
  // 带 --relaunch 的静默安装后自己启动新版本。
  windows: { installerInclude: "installer/installer.nsh" },
  // resources/ 顶层会被整体复制到可执行文件旁边当运行时资源；图标是构建期读的
  // （winres 从 resources/icon.png 生成 exe 资源），不必随程序分发，排掉省 1.2 MB。
  resourcesExclude: ["icon.png", "icon.ico"],
  // 刻意不配 updates 段（#164）：MyGo 的 updates 签的是 <slug>-<版本>-windows-amd64.tar.gz
  // 应用归档，并写出同名的 update-windows-amd64.json；本项目的发布资产是 NSIS 安装器，
  // 描述文件名与语义必须只有一份（见 packaging/release_gate.py 与 RELEASE_164.md）。
  // 安装器的签名由 tools/signrelease 在发布环境用发布者私钥完成。
};
