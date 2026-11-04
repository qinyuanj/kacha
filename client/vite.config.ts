/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 静态资源用相对路径，由 kacha-server 与 API 同端口托管。
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/server/**"] }, proxy: { "/api": "http://localhost:3004" } },
  build: { target: "es2022" },
  test: { include: ["src/**/*.test.ts"] },
});
