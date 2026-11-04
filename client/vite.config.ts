/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 固定端口、不清屏；/api 代理到本地服务端（npm run dev 时）。构建产物用相对资源路径，由服务端托管。
export default defineConfig({
  plugins: [react()],
  // 壳层实现可切换：Web 版走 HTTP；旧假壳 e2e 在 vite.e2e.config.ts 里换成 Tauri 实现。
  resolve: { alias: { "kacha/shell-impl": fileURLToPath(new URL("./src/shell/impl.web.ts", import.meta.url)) } },
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/server/**"] }, proxy: { "/api": "http://localhost:3004" } },
  build: { target: "es2022" },
  // e2e/ 下是 Playwright 用例（npm run test:e2e），不归 vitest。
  test: { include: ["src/**/*.test.ts"] },
});
