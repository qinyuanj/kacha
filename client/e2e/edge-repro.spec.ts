import { expect, test } from "@playwright/test";

test("生成后切换到提示词，任务收起时仍渲染原图与提示词连线", async ({ page }) => {
  await page.goto("/e2e/edge-repro.html");
  await expect(page.locator(".react-flow__background")).toHaveCSS("background-color", "rgb(222, 222, 186)");
  const task = page.locator('.react-flow__node[data-id="t"]');
  await task.click();
  const imageEdge = page.locator(".react-flow__edge.edge-image .react-flow__edge-path");
  const promptEdge = page.locator(".react-flow__edge.edge-positive .react-flow__edge-path");
  await expect(imageEdge).toHaveCount(1);
  await expect(promptEdge).toHaveCount(1);
  await page.getByRole("button", { name: "完成生成" }).click();
  await expect(page.locator(".react-flow__edge.edge-system .react-flow__edge-path")).toHaveCount(1);
  await expect(imageEdge).toHaveCount(1);
  await expect(promptEdge).toHaveCount(1);
  await page.locator('.react-flow__node[data-id="p"]').click();
  await expect(page.getByRole("button", { name: "展开" })).toBeVisible();
  await expect(imageEdge).toHaveCount(1);
  await expect(promptEdge).toHaveCount(1);
});
