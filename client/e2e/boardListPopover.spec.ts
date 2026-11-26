// 画板列表弹层在真实浏览器里的几何边界：960px 最小窗口、长名称与标签多行都不溢出。
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("画板列表弹层锚定在第二行，窄窗口与长名称都不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/e2e.html");

  const toggle = page.locator(".board-toolbar-right").getByRole("button", { name: "画板列表", exact: true });
  await expect(toggle).toBeVisible();
  await expect(page.locator(".tabs").getByRole("button", { name: "画板列表" })).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "画板列表" });
  await expect(dialog).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(960);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);

  const name = dialog.locator(".board-list-open").first();
  await expect(name).toBeVisible();
  const clipped = await name.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(clipped.scroll).toBeGreaterThan(clipped.client);
  const nameBox = await name.boundingBox();
  expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(960);

  // 当前能力截图：第二行右侧入口与锚定非模态弹层。
  mkdirSync("../docs/screenshots", { recursive: true });
  await page.screenshot({ path: "../docs/screenshots/app-canvas-popover.png", animations: "disabled" });
});
