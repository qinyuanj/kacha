// 画板交互在 Web 版与桌面版一致：多标签页、撤销 / 重做、右键菜单、悬浮动作条、平移、拖线建节点。
// 框选与拖线落点规则的核心逻辑另有 core 单测（selection / dragCreate / contextMenu）。
import { expect } from "@playwright/test";
import { board, edge, promptNode, taskNode } from "../common/boards";
import { test } from "./rig";
import { openApp, task } from "./kit";

test("多画板标签页切换与新建", async ({ page, rig }) => {
  await openApp(page, rig, { title: "一", boardText: board("一", [promptNode("p1", "猫")], []) });
  await page.locator(".tab-new").click();
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".tab.tab-active .tab-title")).toHaveText("未命名画板");
  await page.locator(".tab", { hasText: "一" }).locator(".tab-title").click();
  await expect(page.locator(".react-flow__node[data-id='p1']")).toBeVisible();
});

test("撤销 / 重做、右键菜单、悬浮动作条、平移与拖线建节点", async ({ page, rig }) => {
  await openApp(page, rig, { title: "交互", boardText: board("交互", [promptNode("p1", "一只猫"), taskNode("t1")], [edge("p1", "t1", "positive")]) });
  const toolbar = page.getByRole("toolbar", { name: "画板工具栏" });

  // 新建节点 → 撤销 → 重做。
  await toolbar.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await toolbar.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await toolbar.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  // 右键菜单。
  await task(page, "t1").locator(".node-title").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "查看发送文本" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 悬浮动作条：悬停任务节点出现运行按钮。
  await task(page, "t1").locator(".node-task").hover();
  await expect(task(page, "t1").locator(".task-actions button.primary")).toBeVisible();

  // 拖线建节点：从提示词的输出端口拖到空白处，直接建出接好线的生成任务。
  const handle = task(page, "p1").locator(".react-flow__handle[data-handleid='out']").first();
  const box = (await handle.boundingBox())!;
  const tasksBefore = await page.locator(".node-task").count();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1150, 250, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".node-task")).toHaveCount(tasksBefore + 1);

  // 平移：拖动画布空白处改变视口。
  const before = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.mouse.move(1100, 700);
  await page.mouse.down();
  await page.mouse.move(1250, 780, { steps: 8 });
  await page.mouse.up();
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).not.toBe(before);
});
