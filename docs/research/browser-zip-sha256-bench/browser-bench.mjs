// 在真实 Chromium 中跑：静态服务绑定局域网 IP（非 localhost => 非安全上下文）。
// 用法：node browser-bench.mjs <playwright-core 目录> <deps/node_modules> <web 目录> <pack.zip> <ip>
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { pathToFileURL } from "node:url";

const [pwDir, nm, webDir, zipPath, ip] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(join(pwDir, "index.mjs")).href);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const [root, rel] = url.startsWith("/nm/") ? [nm, url.slice(4)] : [webDir, url === "/" ? "index.html" : url.slice(1)];
  const p = normalize(join(root, rel));
  if (!p.startsWith(normalize(root))) return res.writeHead(403).end();
  try { statSync(p); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" });
  createReadStream(p).pipe(res);
}).listen(0, ip);
await new Promise((r) => server.on("listening", r));
const origin = `http://${ip}:${server.address().port}`;

const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(origin + "/");
console.log("origin", origin, JSON.stringify(await page.evaluate(() => window.env())));
await page.setInputFiles("#f", zipPath);
for (const mode of ["main-wasm", "main-noble", "main-zipjs", "worker-wasm", "worker-noble"]) {
  for (let i = 0; i < 2; i++) console.log(JSON.stringify(await page.evaluate((m) => window.bench(m), mode)));
}
await browser.close();
server.close();
