import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { acquireRunLock } from "./e2e/common/run-lock";

// 配置在 clear output 之前加载，锁必须在这里拿；worker 等子进程继承环境变量，不再重复拿。
if (!process.env.KACHA_E2E_RUN_LOCK) {
  process.env.KACHA_E2E_RUN_LOCK = fileURLToPath(new URL("./.e2e-run.lock", import.meta.url));
  const release = acquireRunLock(process.env.KACHA_E2E_RUN_LOCK);
  process.on("exit", release);
}

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
