import { defineConfig, devices } from "@playwright/test";

// 唯一接缝：真浏览器 + 真服务端 + 每测试独立临时数据根。
export default defineConfig({
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    // 非回环主机名：HTTP 下不是安全上下文，覆盖内网真实使用形态。
    launchOptions: { args: ["--host-resolver-rules=MAP kacha.test 127.0.0.1"] },
  },
  testDir: "./e2e/web",
});
