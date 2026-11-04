// 画板存服务端：新建 / 列出 / 打开 / 重命名、跨浏览器同密钥可见、两页面版本冲突、旧名保存报错。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { zipText } from "../common/zip";
import { enterWithKey, expect, GOOD_KEY, metaFile, readMeta, test, type Rig } from "./rig";

/** 界面状态去抖落盘：等它记住当前打开的画板，再开第二个页面。 */
async function waitUiState(rig: Rig, fileName: string) {
  await expect.poll(() => (existsSync(metaFile(rig, GOOD_KEY, "ui-state.json")) ? JSON.stringify(readMeta(rig, GOOD_KEY, "ui-state.json").open_boards) : "")).toContain(fileName);
}

const boardsDir = (root: string) => path.join(root, "画板");
const boardFiles = (root: string) => (existsSync(boardsDir(root)) ? readdirSync(boardsDir(root)).filter((n) => n.endsWith(".ugcboard.json")) : []);
const boardTitles = (root: string) => boardFiles(root).map((n) => JSON.parse(readFileSync(path.join(boardsDir(root), n), "utf8")).title as string);

async function renameActiveTab(page: import("@playwright/test").Page, title: string) {
  await page.locator(".tab.tab-active .tab-title").dblclick();
  await page.locator(".tab.tab-active input").fill(title);
  await page.locator(".tab.tab-active input").press("Enter");
  await expect(page.locator(".tab.tab-active .tab-title")).toHaveText(title);
}

test("画板新建、重命名与内容都落服务端，同密钥另一个浏览器能列出并打开", async ({ page, rig, browser }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  await renameActiveTab(page, "服务端画板");
  await page.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect.poll(() => boardFiles(rig.userRoot(GOOD_KEY))).toEqual(["服务端画板.ugcboard.json"]);
  await expect.poll(() => JSON.parse(readFileSync(path.join(boardsDir(rig.userRoot(GOOD_KEY)), "服务端画板.ugcboard.json"), "utf8")).nodes.length).toBe(1);
  // 关掉标签页后仍能从服务端列表重新打开（桌面版靠拖入文件，Web 版靠列表）。
  await page.locator(".tab-close").click();
  await expect(page.locator(".tab")).toHaveCount(0);
  await page.getByRole("button", { name: "画板列表", exact: true }).click();
  await page.getByRole("dialog", { name: "画板列表" }).getByRole("button", { name: "服务端画板", exact: true }).click();
  await expect(page.locator(".tab.tab-active .tab-title")).toHaveText("服务端画板");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  // 新浏览器没有本页的 ui-state 时也能从列表看到同一份画板；等 ui-state 落盘后，打开的画板会直接恢复。
  await waitUiState(rig, "服务端画板");
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await enterWithKey(page2, rig.baseURL, GOOD_KEY);
  await expect(page2.locator(".tab.tab-active .tab-title")).toHaveText("服务端画板");
  await page2.getByRole("button", { name: "画板列表", exact: true }).click();
  await expect(page2.getByRole("dialog", { name: "画板列表" }).getByRole("button", { name: "服务端画板", exact: true })).toBeVisible();
  await other.close();
});

test("两个页面编辑同一画板：过期保存 409 并提示重新载入，不自动合并", async ({ page, rig, context }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  await renameActiveTab(page, "协作");
  await expect.poll(() => boardFiles(rig.userRoot(GOOD_KEY))).toEqual(["协作.ugcboard.json"]);
  await waitUiState(rig, "协作");
  const page2 = await context.newPage();
  await page2.goto(rig.baseURL);
  await expect(page2.locator(".tab.tab-active .tab-title")).toHaveText("协作");

  // 页面 A 先改并落盘，页面 B 的过期写入必须 409。
  await page.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect.poll(() => JSON.parse(readFileSync(path.join(boardsDir(rig.userRoot(GOOD_KEY)), "协作.ugcboard.json"), "utf8")).nodes.length).toBe(1);
  await page2.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect(page2.getByText("画板已在别处修改，请重新载入", { exact: false })).toBeVisible();
  // 不自动合并：服务端仍是 A 的内容，B 的改动留在页面上。
  expect(JSON.parse(readFileSync(path.join(boardsDir(rig.userRoot(GOOD_KEY)), "协作.ugcboard.json"), "utf8")).nodes.length).toBe(1);
  await expect(page2.locator(".react-flow__node")).toHaveCount(1);
  // 冲突后不再自动重试；用户显式重新载入后拿到 A 的版本。
  await page2.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(page2.getByText("画板已在别处修改，请重新载入", { exact: false })).toHaveCount(0);
  await page2.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect.poll(() => JSON.parse(readFileSync(path.join(boardsDir(rig.userRoot(GOOD_KEY)), "协作.ugcboard.json"), "utf8")).nodes.length).toBe(2);
});

test("另一页面已重命名时，旧名保存明确报错且不多出旧名画板", async ({ page, rig, context }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  await renameActiveTab(page, "原名");
  await expect.poll(() => boardFiles(rig.userRoot(GOOD_KEY))).toEqual(["原名.ugcboard.json"]);
  await waitUiState(rig, "原名");
  const page2 = await context.newPage();
  await page2.goto(rig.baseURL);
  await expect(page2.locator(".tab.tab-active .tab-title")).toHaveText("原名");

  await renameActiveTab(page, "新名");
  await expect.poll(() => boardFiles(rig.userRoot(GOOD_KEY))).toEqual(["新名.ugcboard.json"]);
  await page2.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect(page2.getByText("画板已在别处改名或删除", { exact: false })).toBeVisible();
  expect(boardFiles(rig.userRoot(GOOD_KEY))).toEqual(["新名.ugcboard.json"]);
  // 改动保留在页面上，可重试。
  await expect(page2.locator(".react-flow__node")).toHaveCount(1);
});

test("保存失败后可先导出当前页面改动，不必等保存恢复", async ({ page, rig }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  await renameActiveTab(page, "待备份");
  await expect.poll(() => boardFiles(rig.userRoot(GOOD_KEY))).toEqual(["待备份.ugcboard.json"]);
  await page.route("**/api/boards?*", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "io", message: "保存失败（模拟）" }) }) : route.continue()));
  await page.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  const errorBar = page.locator(".bar-error");
  await expect(errorBar).toContainText("保存失败（模拟）");
  await expect(errorBar.locator(".react-flow__node")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  await errorBar.getByRole("button", { name: "导出画板包", exact: true }).click();
  const packDialog = page.getByRole("dialog", { name: "画板包" });
  await expect(packDialog).toBeVisible();
  const download = page.waitForEvent("download");
  await packDialog.getByRole("button", { name: "导出并下载…" }).click();
  const bytes = readFileSync((await (await download).path())!);
  const packed = JSON.parse(zipText(bytes, "画板/待备份.ugcboard.json"));
  expect(packed.nodes).toHaveLength(1);
  expect(packed.nodes[0].type).toBe("prompt");
  await expect(page.locator(".toast")).toHaveText("已导出画板包 待备份.ugcpack");
  await expect(errorBar).toContainText("保存失败（模拟）");
});

test("保存失败时改动保留，恢复后可重试成功", async ({ page, rig }) => {
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".tab").first()).toBeVisible();
  await page.route("**/api/boards?*", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "io", message: "磁盘满（模拟）" }) }) : route.continue()));
  await page.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect(page.getByText("磁盘满（模拟）", { exact: false })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.unroute("**/api/boards?*");
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.getByText("磁盘满（模拟）", { exact: false })).toHaveCount(0);
  await expect.poll(() => boardTitles(rig.userRoot(GOOD_KEY)).length).toBe(1);
  expect(JSON.parse(readFileSync(path.join(boardsDir(rig.userRoot(GOOD_KEY)), boardFiles(rig.userRoot(GOOD_KEY))[0]), "utf8")).nodes.length).toBe(1);
});
