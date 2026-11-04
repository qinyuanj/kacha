// 新接缝的构建准备：debug 构建真服务端 + 前端静态文件，一次完成。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function globalSetup() {
  const clientDir = fileURLToPath(new URL("..", import.meta.url));
  execFileSync("cargo", ["build"], { cwd: `${clientDir}/../server`, stdio: "inherit" });
  execFileSync(process.execPath, [`${clientDir}/node_modules/vite/bin/vite.js`, "build"], { cwd: clientDir, stdio: "inherit" });
}
