// 画板在真实浏览器里启动，并验证精简工具栏后的键盘菜单链路（#261 / #267）。
// 这里只跑用户可观察行为：没有新建按钮，Shift+F10 打开菜单，方向键导航、回车建真实节点，Esc 返回焦点。
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("真实浏览器：精简工具栏与画板菜单键盘链路", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/e2e.html");

  await expect(page.getByRole("button", { name: "Kacha 9.9.9" })).toBeVisible();
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".fatal")).toHaveCount(0);

  const canvas = page.locator(".canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator(".react-flow")).toBeVisible();
  await expect(canvas).toHaveCSS("position", "absolute");

  const toolbar = page.getByRole("toolbar", { name: "画板工具栏" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button").first()).toHaveAttribute("aria-label", "撤销");
  await expect(page.getByRole("button", { name: "＋ 提示词" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ 参考图…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /＋ 生成任务/ })).toHaveCount(0);
  await expect(page.locator(".toolbar-model")).toHaveCount(0);

  // 焦点落在画布后，Shift+F10 打开的是画板菜单；菜单首项自动聚焦。
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const newPrompt = page.getByRole("menuitem", { name: "新建提示词" });
  const newTask = page.getByRole("menuitem", { name: "新建生成任务" });
  await expect(newPrompt).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(newTask).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "添加参考图…" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(newPrompt).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(menu).toHaveCount(0);
  await expect(canvas).toBeFocused();
  const node = canvas.locator(".react-flow__node");
  await expect(node).toHaveCount(1);
  await expect(node).toBeVisible();
  await expect(node).toHaveCSS("position", "absolute");

  // 当前能力截图：精简后的工具栏与键盘菜单创建的真实节点。
  mkdirSync("../docs/screenshots", { recursive: true });
  await page.screenshot({ path: "../docs/screenshots/workbench-toolbar.png", animations: "disabled" });

  // Esc 关闭同一个键盘菜单，并把焦点还给画布。
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(canvas).toBeFocused();

  expect(errors).toEqual([]);
});
