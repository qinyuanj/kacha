/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 静态资源由 MyGo 桌面壳加载。
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [".", "../docs/release"] } },
  build: { target: "es2022" },
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
