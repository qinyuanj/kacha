/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 静态资源用相对路径，由 kacha-server 与 API 同端口托管。
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/server/**"] }, proxy: { "/api": "http://localhost:3004" }, fs: { allow: [".", "../docs/release"] } },
  build: { target: "es2022" },
  // e2e/common 下是 rig 用的纯逻辑（如端口判断），单测与 src 一起跑；playwright 只收 e2e/web。
  test: { include: ["src/**/*.test.ts", "e2e/common/**/*.test.ts"] },
});
