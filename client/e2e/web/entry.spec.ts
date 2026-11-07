// 进入与身份：非回环主机名（非安全上下文）下粘贴密钥进入工作台、无效密钥、会话、退出、按用户隔离。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_HINT_TEXT } from "../../src/ui/boardText";
import { BAD_KEY, enterWithKey, expect, GOOD_KEY, metaFile, OTHER_KEY, OUTAGE_KEY, readMeta, test } from "./rig";

test("非安全上下文下粘贴有效密钥进入工作台，顶栏显示版本与备份提示", async ({ page, rig }) => {
  await page.goto(rig.baseURL);
  await expect(page.getByRole("dialog", { name: "粘贴 API 密钥" })).toBeVisible();
  await expect(page.getByText("换密钥即视为新用户", { exact: false })).toBeVisible();
  // 必须真是非安全上下文，否则「替换了受限 API」的结论不成立。
  const env = await page.evaluate(() => ({ secure: window.isSecureContext, subtle: !!globalThis.crypto.subtle, uuid: !!globalThis.crypto.randomUUID, clipboard: !!navigator.clipboard }));
  expect(env).toEqual({ secure: false, subtle: false, uuid: false, clipboard: false });

  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.getByRole("dialog", { name: "粘贴 API 密钥" })).toHaveCount(0);
  // 空工作台自动建一张画板，顶栏显示服务端 crate 清单里的版本号。
  await expect(page.locator(".tab").first()).toBeVisible();
  await expect(page.locator(".topbar-version")).toHaveText(/Kacha \d+\.\d+\.\d+/);
  await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
  const manifest = /version = "([^"]+)"/.exec(readFileSync(fileURLToPath(new URL("../../../server/Cargo.toml", import.meta.url)), "utf8"))![1];
  await expect(page.locator(".topbar-version")).toHaveText(`Kacha ${manifest}`);
  // 顶栏常驻备份提示。
  const hint = page.locator(".topbar-backup-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText(BACKUP_HINT_TEXT);
  // 画板落在该用户的用户数据根下。
  expect(existsSync(path.join(rig.userRoot(GOOD_KEY), "画板"))).toBe(true);
  // 密钥保存在浏览器本地，供浏览器直连网关。
  expect(await page.evaluate(() => localStorage.getItem("kacha.apiKey"))).toBe(GOOD_KEY);
});

test("会话 cookie 对页面脚本不可见，刷新后无需重新粘贴", async ({ page, rig }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).toBe("");

  await page.reload();
  await expect(page.locator(".tab").first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "粘贴 API 密钥" })).toHaveCount(0);
});

test("无效密钥与网关故障给出不同错误", async ({ page, rig }) => {
  await page.goto(rig.baseURL);
  await enterWithKey(page, rig.baseURL, BAD_KEY);
  await expect(page.getByRole("alert")).toContainText("密钥");
  await expect(page.locator(".tab")).toHaveCount(0);
  expect(existsSync(rig.userRoot(BAD_KEY))).toBe(false);

  await enterWithKey(page, rig.baseURL, OUTAGE_KEY);
  await expect(page.getByRole("alert")).toContainText("这不是密钥问题");
});

test("会话失效时提示重新粘贴密钥，页面上的改动不丢", async ({ page, rig }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  // 会话过期由服务端单测覆盖；这里在接口层模拟 401，验证页面表现。
  await page.route("**/api/settings", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "unauthenticated", message: "会话已失效" }) }));
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  await page.getByRole("dialog", { name: "高级设置" }).getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("会话已失效，请重新粘贴 API 密钥", { exact: false })).toBeVisible();
  await expect(page.locator(".tab").first()).toBeVisible();
  // 只模拟一次会话失效；恢复后撤销拦截，否则重新进入时的设置读取仍会被拦成 401。
  await page.unroute("**/api/settings");
  await page.getByLabel("API 密钥", { exact: true }).fill(GOOD_KEY);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByText("会话已失效，请重新粘贴 API 密钥", { exact: false })).toHaveCount(0);
});

test("退出后会话作废并回到粘贴界面", async ({ page, rig }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "粘贴 API 密钥" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("kacha.apiKey"))).toBeNull();
  const res = await page.request.get(`${rig.localURL}/api/session`);
  expect(res.status()).toBe(401);
});

test("设置按用户隔离，换密钥即新用户", async ({ page, rig, browser }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  const dialog = page.getByRole("dialog", { name: "高级设置" });
  await expect(dialog.getByText("输出根目录")).toHaveCount(0);
  await dialog.getByLabel("并发上限").fill("7");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  // 保存是异步 HTTP：等服务端真正落盘再读，避免竞态。
  await expect.poll(() => (existsSync(metaFile(rig, GOOD_KEY, "settings.json")) ? readMeta(rig, GOOD_KEY, "settings.json").concurrency : null)).toBe(7);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await enterWithKey(page2, rig.baseURL, OTHER_KEY);
  await page2.getByRole("button", { name: "⚙ 高级设置" }).click();
  await expect(page2.getByRole("dialog", { name: "高级设置" }).getByLabel("并发上限")).toHaveValue("4");
  expect(existsSync(metaFile(rig, OTHER_KEY, "settings.json"))).toBe(false);
  await other.close();
});
