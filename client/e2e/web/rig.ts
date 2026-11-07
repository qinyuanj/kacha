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
import { MODELS, png } from "../common/boards";
import { startOnSafePort, type Started } from "../common/ports";

const clientDir = fileURLToPath(new URL("../..", import.meta.url));
const serverBin = path.join(clientDir, "../server/target/debug/kacha-server");
const staticDir = path.join(clientDir, "dist");

export const GOOD_KEY = "sk-e2e-good";
export const OTHER_KEY = "sk-e2e-other";
export const BAD_KEY = "sk-e2e-bad";
export const OUTAGE_KEY = "sk-e2e-outage";

/** 桩收到的生成请求体：image 在入口解析成字符串数组，其余字段原样保留。 */
export type ImageRequestBody = Record<string, unknown> & { image?: string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseImageRequest(raw: string): ImageRequestBody {
  const { image, ...rest }: Record<string, unknown> = raw ? JSON.parse(raw) : {};
  if (image === undefined) return rest;
  if (!isStringArray(image)) throw new Error(`生成请求的 image 不是字符串数组：${raw.slice(0, 200)}`);
  return { ...rest, image };
}

export interface Stub {
  url: string;
  /** 生成请求记录（path + 解析后的 JSON body），供断言请求形状。 */
  requests: { path: string; body: ImageRequestBody }[];
  /** 对象存储内容（不带 CORS，只能由服务端中转）；默认 /objects/result.png 是真 PNG。 */
  objects: Map<string, Buffer>;
  /** 对象存储对全部 /objects/* 返回的失败状态；null 时正常返回。 */
  objectStatus: number | null;
  /** 自定义生成响应；返回 null 走默认：结果图指向本桩的对象存储（url 形式，走中转）。 */
  imageResponse: ((path: string, body: ImageRequestBody) => { status?: number; json?: unknown } | null) | null;
  /** 非 null 时生成请求挂到它兑现后才应答，用来让任务停在执行中。 */
  holdImages: Promise<void> | null;
  close(): Promise<void>;
}

/** 网关：验证密钥（/api/usage/token）、模型列表与文生图；对象存储：/objects/*（无 CORS）。 */
async function startStub(): Promise<Stub> {
  const objects = new Map<string, Buffer>([["/objects/result.png", Buffer.from(png(64, 64), "base64")]]);
  const requests: Stub["requests"] = [];
  const stub: Stub = { url: "", requests, objects, objectStatus: null, imageResponse: null, holdImages: null, close: async () => undefined };
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
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
    }
    if (isStore) {
      if (stub.objectStatus !== null) return void res.writeHead(stub.objectStatus).end("denied");
      const bytes = objects.get(url);
      if (!bytes) return void res.writeHead(404).end("not found");
      return void res.writeHead(200, { "Content-Type": "image/png" }).end(bytes);
    }
    if (url.startsWith("/v1/images/")) {
      let raw = "";
      req.on("data", (d) => (raw += String(d)));
      req.on("end", async () => {
        const body = parseImageRequest(raw);
        requests.push({ path: url, body });
        await stub.holdImages;
        const custom = stub.imageResponse?.(url, body);
        if (custom) return void res.writeHead(custom.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(custom.json ?? {}));
        const image = `${stub.url}/objects/result.png`;
        // Seedream（doubao）走 data[]，qwen 走 metadata.output.choices；结果默认 url 形式以覆盖服务端中转。
        const isSeedream = String(body.model ?? "").startsWith("doubao");
        const json = isSeedream ? { data: [{ url: image }] } : { metadata: { output: { choices: [{ message: { content: [{ image }] } }] } } };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(json));
      });
      return;
    }
    res.writeHead(404).end("not mocked");
  });
  // 浏览器直连本桩；Chrome 预开、尚未发请求的连接不算空闲，server.close() 不会关它，拆除会一直等到超时。
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  const { port } = await startOnSafePort("本地桩", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, value: server, release: close };
  });
  stub.url = `http://127.0.0.1:${port}`;
  stub.close = close;
  return stub;
}

/** 起一个服务端进程，等它在 stdout 报出监听端口；release 杀掉进程并等它真正退出。 */
async function spawnServer(dataRoot: string, gatewayURL: string): Promise<Started<ChildProcess>> {
  const child: ChildProcess = spawn(
    serverBin,
    ["--listen", "127.0.0.1:0", "--data-root", dataRoot, "--gateway-url", gatewayURL, "--static-dir", staticDir, "--result-hosts", "127.0.0.1"],
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
  return { port, value: child, release: () => stopServer(child) };
}

/** 先等服务端真正退出再返回：kill 只是发信号，进程退出前仍可能在写数据根。 */
async function stopServer(child: ChildProcess) {
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
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

/** 桩按到达顺序收到的生成请求体。 */
export const bodies = (rig: Rig) => rig.stub.requests.map((r) => r.body);

export const test = base.extend<{ rig: Rig }>({
  rig: async ({}, use) => {
    const stub = await startStub();
    const dataRoot = mkdtempSync(path.join(tmpdir(), "kacha-e2e-"));
    const { port, value: child } = await startOnSafePort("服务端", () => spawnServer(dataRoot, stub.url));
    await use({
      baseURL: `http://kacha.test:${port}`,
      localURL: `http://127.0.0.1:${port}`,
      dataRoot,
      stub,
      userRoot: (key) => {
        return path.join(dataRoot, "users", createHash("sha256").update(key).digest("hex"));
      },
    });
    // 先等服务端真正退出再删数据根：页面此时还开着，进程退出前仍可能在写缩略图缓存、
    // 画板或任务文件，与递归删除赛跑会报 ENOTEMPTY。
    await stopServer(child);
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
