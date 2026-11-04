// 新 e2e 接缝：真浏览器 + debug 构建的真服务端 + 每测试独立临时数据根 + 本地桩服务。
// 桩同时扮演 new-api 网关（带 CORS，浏览器直连）与对象存储（不带 CORS，只能由服务端中转）。
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL("../..", import.meta.url));
const serverBin = path.join(clientDir, "../server/target/debug/kacha-server");
const staticDir = path.join(clientDir, "dist");

export const GOOD_KEY = "sk-e2e-good";
export const OTHER_KEY = "sk-e2e-other";
export const BAD_KEY = "sk-e2e-bad";
export const OUTAGE_KEY = "sk-e2e-outage";

export interface Stub {
  url: string;
  close(): Promise<void>;
}

/** 网关：验证密钥（/api/usage/token）与模型列表；对象存储：/objects/result.png。 */
export async function startStub(): Promise<Stub> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const isStore = url.startsWith("/objects/");
    if (!isStore) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
      if (req.method === "OPTIONS") return void res.writeHead(204).end();
    }
    if (url === "/api/usage/token") {
      const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (key === OUTAGE_KEY) return void res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "upstream down" }));
      if (key === GOOD_KEY || key === OTHER_KEY) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { name: "e2e", remain_quota: 100 } }));
      return void res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "无效令牌" }));
    }
    if (url === "/v1/models") {
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen-image-3.0-pro" }, { id: "doubao-seedream-5-0-flash-260915" }] }));
    }
    if (isStore) return void res.writeHead(200, { "Content-Type": "image/png" }).end("not-a-real-png");
    res.writeHead(404).end("not mocked");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export interface Rig {
  /** 非回环主机名：HTTP 下不是安全上下文，crypto.subtle / randomUUID / clipboard 都不可用。 */
  baseURL: string;
  /** 回环地址：Playwright 的 APIRequestContext 不走 Chromium 的 host-resolver-rules。 */
  localURL: string;
  dataRoot: string;
  stub: Stub;
  userRoot(key: string): string;
}

export const test = base.extend<{ rig: Rig }>({
  rig: async ({}, use) => {
    const stub = await startStub();
    const dataRoot = mkdtempSync(path.join(tmpdir(), "kacha-e2e-"));
    const child: ChildProcess = spawn(
      serverBin,
      ["--listen", "127.0.0.1:0", "--data-root", dataRoot, "--gateway-url", stub.url, "--static-dir", staticDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务端未在 10 秒内就绪：${stderr}`)), 10_000);
      child.stdout?.on("data", (d) => {
        const m = /监听 http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d));
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`服务端提前退出（${code}）：${stderr}`));
      });
    });
    await use({
      baseURL: `http://kacha.test:${port}`,
      localURL: `http://127.0.0.1:${port}`,
      dataRoot,
      stub,
      userRoot: (key) => {
        return path.join(dataRoot, "users", createHash("sha256").update(key).digest("hex"));
      },
    });
    child.kill();
    await stub.close();
    rmSync(dataRoot, { recursive: true, force: true });
  },
});

export { expect };

export async function enterWithKey(page: Page, baseURL: string, key: string) {
  await page.goto(baseURL);
  await page.getByLabel("API 密钥", { exact: true }).fill(key);
  await page.getByRole("button", { name: "进入工作台" }).click();
}

export const metaFile = (rig: Rig, key: string, name: string) => path.join(rig.userRoot(key), ".kacha", name);
export const readMeta = (rig: Rig, key: string, name: string) => JSON.parse(readFileSync(metaFile(rig, key, name), "utf8"));
