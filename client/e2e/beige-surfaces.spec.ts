// 浅色米色语义表面（#266）：在真实浏览器里读计算色，不靠搜索 CSS 文本或全局替换白色。
// 这里守的是用户真正看见的层级：外壳、工具栏、节点、控件、右键菜单、浮层、预览侧栏、弹窗与输入控件；
// 画布底色 #dedeba、连线与区域指示由 edge-repro / token 契约各自守，不在本文件重复断言。
import { expect, test } from "@playwright/test";

type Rgb = [number, number, number];

function parseRgb(value: string): Rgb {
  const matched = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!matched) throw new Error(`无法解析计算色 ${value}`);
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}

function rgbText([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** 米色家族：红绿近似相等且明显高于蓝，明度落在浅色表面区间。 */
function beigeSurface([r, g, b]: Rgb): boolean {
  return r >= 200 && g >= 195 && b >= 150 && g - b >= 12 && Math.abs(r - g) <= 10;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function lightness([r, g, b]: Rgb): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

test("浅色工作台的计算色是分层米色，深色关键色未被改动", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/e2e.html");
  await expect(page.locator(".workspace .react-flow")).toBeVisible();

  const pane = page.locator(".react-flow__pane");
  const menu = page.locator(".context-menu");

  // 用真实画板右键菜单创建两类用户节点；四类节点共用 .node 的表面 token，
  // 因此这里验的是任意节点卡片实际拿到的计算色，而不是某个节点的专属样式。
  await pane.click({ button: "right", position: { x: 300, y: 220 } });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "新建提示词" }).click();
  await expect(page.locator(".react-flow__node .node")).toHaveCount(1);

  await pane.click({ button: "right", position: { x: 760, y: 220 } });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "新建生成任务" }).click();
  await expect(page.locator(".react-flow__node .node")).toHaveCount(2);

  // 页面已经挂载完主题副作用后切到浅色：计算色来自真实级联，不是 token 字符串。
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

  await pane.click({ button: "right", position: { x: 1000, y: 560 } });
  await expect(menu).toBeVisible();
  const menuColors = await page.evaluate(() => {
    const read = (selector: string, property: "backgroundColor" | "color" = "backgroundColor"): string => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`找不到 ${selector}`);
      return getComputedStyle(element)[property];
    };
    return {
      topbar: read(".topbar"),
      toolbar: read(".board-toolbar"),
      canvas: read(".workspace"),
      node: read(".react-flow__node .node"),
      nodeText: read(".react-flow__node .node-title", "color"),
      control: read(".board-toolbar button:not(.primary):not(.danger)"),
      menu: read(".context-menu"),
    };
  });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // 任务节点的模型说明浮层：.popover 用的也是抬升表面 token。
  await page.getByRole("button", { name: "模型说明" }).click();
  const modelPopover = page.locator(".popover");
  await expect(modelPopover).toBeVisible();
  const modelPopoverColor = await modelPopover.evaluate((el) => getComputedStyle(el).backgroundColor);
  await modelPopover.getByRole("button", { name: "关闭" }).click();
  await expect(modelPopover).toHaveCount(0);

  // 画板列表是锚定浮层，不是模态框：同样取真实计算色。
  await page.locator(".board-toolbar-right").getByRole("button", { name: "画板列表", exact: true }).click();
  const listPopover = page.locator(".board-list-popover");
  await expect(listPopover).toBeVisible();
  const listPopoverColor = await listPopover.evaluate((el) => getComputedStyle(el).backgroundColor);

  // 打开带图层的结果画板，进入放大预览：真实侧栏 .preview-side 也是抬升表面。
  await listPopover.locator(".board-list-open", { hasText: "米色预览" }).click();
  await expect(page.locator(".react-flow__node .node")).toHaveCount(1);
  await page.locator(".react-flow__node").first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "放大预览" }).click();
  const preview = page.getByRole("dialog", { name: "result.png" });
  await expect(preview).toBeVisible();
  const previewSidebar = page.locator(".preview-side");
  await expect(previewSidebar).toBeVisible();
  const previewColors = await previewSidebar.evaluate((el) => {
    const muted = el.querySelector(".muted");
    if (!muted) throw new Error("预览侧栏没有次级文字");
    // 侧栏自身刻意透明，实际表面由最近的祖先提供；沿祖先链读第一层真实底色。
    const effectiveBackground = (): string => {
      for (let node: Element | null = el; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
      }
      throw new Error("预览侧栏没有可计算的实际底色");
    };
    return { background: effectiveBackground(), mutedText: getComputedStyle(muted).color };
  });
  await preview.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(preview).toHaveCount(0);

  await page.getByRole("button", { name: /高级设置/ }).click();
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible();
  const dialogColors = await page.evaluate(() => {
    const read = (selector: string): string => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`找不到 ${selector}`);
      return getComputedStyle(element).backgroundColor;
    };
    const muted = document.querySelector(".settings-dialog .muted");
    if (!muted) throw new Error("设置弹窗没有次级文字");
    return {
      modal: read(".settings-dialog"),
      input: read('.settings-dialog input:not([type="checkbox"]):not([type="radio"])'),
      secondaryText: getComputedStyle(muted).color,
    };
  });

  const surfaces: [string, string][] = [
    ["外壳", menuColors.topbar],
    ["工具栏", menuColors.toolbar],
    ["节点", menuColors.node],
    ["控件", menuColors.control],
    ["右键菜单", menuColors.menu],
    ["模型说明浮层", modelPopoverColor],
    ["画板列表浮层", listPopoverColor],
    ["预览图层侧栏", previewColors.background],
    ["弹窗", dialogColors.modal],
    ["输入控件", dialogColors.input],
  ];
  for (const [name, value] of surfaces) {
    expect(beigeSurface(parseRgb(value)), `${name} 的计算色 ${value} 不是米色家族`).toBe(true);
  }

  const layers = [menuColors.topbar, menuColors.canvas, dialogColors.input, menuColors.toolbar, menuColors.control, menuColors.node, dialogColors.modal].map(parseRgb);
  for (let i = 1; i < layers.length; i += 1) {
    const gap = Math.abs(lightness(layers[i]) - lightness(layers[i - 1]));
    expect(gap, `相邻层级明度太接近：${layers.map(rgbText).join(" → ")}`).toBeGreaterThanOrEqual(2);
  }

  expect(contrast(parseRgb(menuColors.nodeText), parseRgb(menuColors.node)), "节点正文对其实际背景").toBeGreaterThanOrEqual(4.5);
  expect(contrast(parseRgb(dialogColors.secondaryText), parseRgb(dialogColors.modal)), "弹窗次级文字对其实际背景").toBeGreaterThanOrEqual(4.5);
  expect(contrast(parseRgb(previewColors.mutedText), parseRgb(previewColors.background)), "预览侧栏次级文字对其实际背景").toBeGreaterThanOrEqual(4.5);

  // 深色关键色是回归护栏：浅色 token 调整不得改变既有暗色外观。
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  const dark = await page.evaluate(() => {
    const read = (selector: string): string => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`找不到 ${selector}`);
      return getComputedStyle(element).backgroundColor;
    };
    return {
      topbar: read(".topbar"),
      toolbar: read(".board-toolbar"),
      node: read(".react-flow__node .node"),
      canvas: read(".workspace"),
    };
  });
  expect(dark).toEqual({
    topbar: "rgb(22, 26, 32)",
    toolbar: "rgb(20, 24, 30)",
    node: "rgb(27, 32, 39)",
    canvas: "rgb(15, 18, 23)",
  });
  expect(errors).toEqual([]);
});

// 本票专属截图：默认跳过，只有显式采集时才覆盖 docs/screenshots/light-beige-surfaces.png。
// 八票共用的 app-canvas.png 留给集成阶段统一重拍，不在本票分支上抢写。
test("采集浅色米色能力截图（默认跳过）", async ({ page }) => {
  test.skip(!process.env.CAPTURE_BEIGE_SCREENSHOT, "截图采集默认跳过");
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/e2e.html");
  await expect(page.locator(".workspace .react-flow")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

  const pane = page.locator(".react-flow__pane");
  await pane.click({ button: "right", position: { x: 430, y: 300 } });
  await page.locator(".context-menu").getByRole("menuitem", { name: "新建提示词" }).click();
  await pane.click({ button: "right", position: { x: 900, y: 300 } });
  await page.locator(".context-menu").getByRole("menuitem", { name: "新建生成任务" }).click();
  await expect(page.locator(".react-flow__node .node")).toHaveCount(2);
  await page.screenshot({ path: "../docs/screenshots/light-beige-surfaces.png" });
});
