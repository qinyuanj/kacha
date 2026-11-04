import { defineConfig, devices } from "@playwright/test";

// 两个 project：legacy = 旧 Tauri 假壳（后续票迁走后由 #26 删除）；web = 真服务端 + 非回环主机名新接缝。
export default defineConfig({
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { viewport: { width: 1600, height: 1000 }, trace: "retain-on-failure" },
  projects: [
    {
      name: "legacy",
      testDir: "./e2e/specs",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:1421", viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "web",
      testDir: "./e2e/web",
      // 非回环主机名：HTTP 下不是安全上下文，覆盖内网真实使用形态。
      use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--host-resolver-rules=MAP kacha.test 127.0.0.1"] } },
    },
  ],
  webServer: { command: "npx vite --config vite.e2e.config.ts", url: "http://localhost:1421/e2e/app.html", reuseExistingServer: true },
});
