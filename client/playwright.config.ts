// e2e 配置：起 vite dev server（1420），用 Chromium 跑真实浏览器交互。
// 只跑 e2e/ 下的 *.spec.ts；单元测试仍归 vitest（vite.config.ts 的 test.include）。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // 串行跑：画板用例之间会抢同一个 dev server，且这台机器内存有限。
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // 显式绑 127.0.0.1：vite 默认只监听 localhost，在某些机器上会落到 ::1，
    // Playwright 探 127.0.0.1 就永远等不到（实测卡满 120s 超时）。
    command: "npx vite --host 127.0.0.1",
    url: "http://127.0.0.1:1420/e2e.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
