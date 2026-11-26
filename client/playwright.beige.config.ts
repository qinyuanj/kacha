// #266 专用端口：并行工作树可能各自占用 1420，公共配置的 reuseExistingServer
// 会让本票浏览器测试读到另一棵工作树的旧 CSS。这里用独立端口并把复用关掉，
// 保证计算色证据来自本分支的样式产物。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/beige-surfaces.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1426",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 1426 --strictPort",
    url: "http://127.0.0.1:1426/e2e.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
