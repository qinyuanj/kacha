import type { KnipConfig } from "knip";

// 死代码检查（npm run lint:dead = knip && knip --production；verify.py 会跑）。
// production 模式只从生产入口出发，不计测试文件里的引用：只被测试调用的导出会被报告。
// 生产入口：index.html → src/main.tsx 由 vite 插件自动识别；Worker 由 ipc.ts 以 new URL(...) 启动，knip 跟不到，手列。
// 测试/工具入口（*.test.ts、e2e、playwright/vite 配置）由 vitest/playwright/vite 插件识别，--production 下自动排除。
const config: KnipConfig = {
  entry: ["src/shell/packHash.worker.ts!"],
  // src/core/testing/** 是测试夹具与替身，只被 *.test.ts 引用：不属于生产项目文件。
  project: ["src/**/*.{ts,tsx}!", "!src/core/testing/**!", "e2e/**/*.ts", "*.config.ts"],
  // 本文件内仍有生产调用的导出不算死代码（只是同时作为单测接缝导出）；
  // 真正要抓的是「整个生产图里都没有调用方」的符号。
  ignoreExportsUsedInFile: true,
};

export default config;
