// 高级设置文件状态（#76）：newer 与读取失败时面板提示、禁止保存，服务端 settings.json 保持原文。
// 并发上限输入框（#82）：输入中不钳制，失焦与保存时钳制。
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { SETTINGS_UNREADABLE_TEXT, settingsNewerText } from "../../src/ui/settingsText";
import { board } from "../common/boards";
import { openApp } from "./kit";
import { expect, GOOD_KEY, metaFile, type Rig, test } from "./rig";

const TITLE = "设置";
// 手写而不导入 DEFAULT_SETTINGS：core/settings 在 Node 里加载不了（capabilities 的 JSON 导入），
// 与 settings.test.ts「缺失时用默认值：v1 网关地址、并发 4」是同一份独立期望值。
const DEFAULT_CONCURRENCY = "4";

test("settings.json 由更新版本写入：提示、禁止保存、并发上限显示默认值，磁盘文件保持原文", async ({ page, rig }) => {
  const newer = JSON.stringify({ format_version: 99, concurrency: 2 });
  await openApp(page, rig, { title: TITLE, boardText: board(TITLE, [], []), settings: newer });
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  const dialog = page.getByRole("dialog", { name: "高级设置" });
  await expect(dialog.getByText(settingsNewerText(99), { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("并发上限")).toHaveValue(DEFAULT_CONCURRENCY);
  expect(readFileSync(metaFile(rig, GOOD_KEY, "settings.json"), "utf8")).toBe(newer);
});

test("读取 settings.json 失败（HTTP 500）：提示、禁止保存，磁盘文件保持原文", async ({ page, rig }) => {
  const saved = JSON.stringify({ format_version: 1, base_url: rig.stub.url, concurrency: 7 });
  await page.route("**/api/settings", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "internal", message: "boom" }) }) : route.continue(),
  );
  await openApp(page, rig, { title: TITLE, boardText: board(TITLE, [], []), settings: saved });
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  const dialog = page.getByRole("dialog", { name: "高级设置" });
  await expect(dialog.getByText(SETTINGS_UNREADABLE_TEXT, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("并发上限")).toHaveValue(DEFAULT_CONCURRENCY);
  expect(readFileSync(metaFile(rig, GOOD_KEY, "settings.json"), "utf8")).toBe(saved);
});

// 并发上限（#82）：逐键输入（pressSequentially）才能复现每键钳制；fill() 一次替换整个值测不出来。
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  const dialog = page.getByRole("dialog", { name: "高级设置" });
  return { dialog, input: dialog.getByLabel("并发上限"), save: dialog.getByRole("button", { name: "保存", exact: true }) };
}
const savedConcurrency = (rig: Rig) => JSON.parse(readFileSync(metaFile(rig, GOOD_KEY, "settings.json"), "utf8")).concurrency;

test("并发上限：清空后逐键输入 7，失焦显示 7，保存后重新打开仍是 7", async ({ page, rig }) => {
  await openApp(page, rig, { title: TITLE, boardText: board(TITLE, [], []) });
  const { dialog, input, save } = await openSettings(page);
  await expect(input).toHaveValue(DEFAULT_CONCURRENCY);
  await input.press("End");
  await input.press("Backspace");
  await expect(input).toHaveValue("");
  await input.pressSequentially("7");
  await input.blur();
  await expect(input).toHaveValue("7");
  await save.click();
  await expect(dialog).toBeHidden();
  expect(savedConcurrency(rig)).toBe(7);
  const reopened = await openSettings(page);
  await expect(reopened.input).toHaveValue("7");
});

test("并发上限：逐键输入 17 后失焦，显示 10", async ({ page, rig }) => {
  await openApp(page, rig, { title: TITLE, boardText: board(TITLE, [], []) });
  const { input } = await openSettings(page);
  await input.press("End");
  await input.press("Backspace");
  await input.pressSequentially("17");
  await expect(input).toHaveValue("17");
  await input.blur();
  await expect(input).toHaveValue("10");
});

test("并发上限：清空后直接保存，保存的是打开面板时的原值", async ({ page, rig }) => {
  await openApp(page, rig, { title: TITLE, boardText: board(TITLE, [], []), settings: JSON.stringify({ format_version: 1, base_url: rig.stub.url, concurrency: 3 }) });
  const { dialog, input, save } = await openSettings(page);
  await input.press("End");
  await input.press("Backspace");
  await expect(input).toHaveValue("");
  await save.click();
  await expect(dialog).toBeHidden();
  expect(savedConcurrency(rig)).toBe(3);
});
