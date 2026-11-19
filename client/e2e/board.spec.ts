// 第一个 e2e：浏览器里把画板真的挂起来。
// 断言的是"用户看得见的东西"：顶栏版本按钮、工作区、没有致命错误块。
import { expect, test } from "@playwright/test";

test("画板在真实浏览器里启动：顶栏版本、工作区、无致命错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/e2e.html");

  // 顶栏版本按钮由 Root 拿到的 port.ui.version() 决定，替身固定返回 9.9.9。
  await expect(page.getByRole("button", { name: "Kacha 9.9.9" })).toBeVisible();

  // 工作台外壳挂起来了（没有停在"正在加载…"或致命错误）。
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".fatal")).toHaveCount(0);

  expect(errors).toEqual([]);
});
