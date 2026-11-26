// 画板在真实浏览器里启动：断言的是「用户看得见的画布」，不只是外壳。
// 外壳出现但画布没挂载，正是加载失败或整页白屏的样子；这里要求画布根元素与真实节点都渲染出来。
import { expect, test } from "@playwright/test";

test("画板在真实浏览器里启动：顶栏版本、画布根元素与真实节点都可见", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/e2e.html");

  // 顶栏版本按钮由 Root 拿到的 port.ui.version() 决定，替身固定返回 9.9.9。
  await expect(page.getByRole("button", { name: /当前版本 9\.9\.9/ })).toBeVisible();

  // 工作台外壳挂起来了（没有停在"正在加载…"或致命错误）。
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".fatal")).toHaveCount(0);

  // 画布真的挂上了：根元素可见，React Flow 的视口也在。
  // 只断言 .app 时，画布没挂载（白屏的下半截）照样能绿；这两条才是「画布存在」的证据。
  const canvas = page.locator(".canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator(".react-flow")).toBeVisible();

  // 样式表真的加载了。只断言元素存在时，整页零样式（CSS 崩溃、白屏、忘记引入样式）照样能绿：
  // .canvas 的 position 来自 src/styles.css，.react-flow__node 的 position 来自
  // @xyflow/react/dist/style.css；两个样式表缺一个，下面两条就会退回 static。
  await expect(canvas).toHaveCSS("position", "absolute");

  // 新建一个提示词节点：画布不只是空壳，节点真的渲染出来且可见。
  await page.getByRole("button", { name: "＋ 提示词" }).click();
  const node = canvas.locator(".react-flow__node");
  await expect(node).toHaveCount(1);
  await expect(node).toBeVisible();
  // 节点的 position 来自 @xyflow/react 的样式表：它没被加载时节点会退回 static，布局随之散架。
  await expect(node).toHaveCSS("position", "absolute");

  expect(errors).toEqual([]);
});
