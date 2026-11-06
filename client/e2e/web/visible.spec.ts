// 画布只渲染可见节点（#66）：视口外的节点不在 DOM 中，交互照常作用于它们；悬浮动作条、未提交文本、自动聚焦三处修补。
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { openApp, savedNodes, task } from "./kit";
import { test } from "./rig";

const REF = "导入参考图/a.png";

/** 带初始视口的画板 JSON。 */
function boardAt(title: string, nodes: unknown[], edges: unknown[], viewport: { x: number; y: number; zoom: number }) {
  return JSON.stringify({ ...JSON.parse(board(title, nodes, edges)), viewport });
}

/** 触控板双指平移：画面内容移动 (dx, dy) 屏幕像素。横向分量非零才按平移处理（见 core/selection 的 isTrackpadPan）。 */
async function pan(page: Page, dx: number, dy: number) {
  await page.mouse.wheel(dx === 0 ? -1 : -dx, -dy);
}

/** 指针移到画布空白处（左下角上方，避开 Controls 与 MiniMap）。 */
async function moveToBlank(page: Page) {
  const box = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
}

const domIds = (page: Page) => page.locator(".react-flow__node").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")).sort());

// 近处一组（p1 → t1），远处一组（pFar → tFar），近处 pNear 接远处 tFar：一端在视口外的连线。
const bigBoard = (title: string) =>
  boardAt(
    title,
    [
      promptNode("p1", "近处", [0, 0]),
      taskNode("t1", {}, [400, 0]),
      promptNode("pNear", "接远处", [0, 400]),
      promptNode("pFar", "远处", [4000, 0]),
      taskNode("tFar", {}, [4400, 0]),
    ],
    [edge("p1", "t1", "positive"), edge("pNear", "tFar", "positive"), edge("pFar", "tFar", "negative")],
    { x: 100, y: 100, zoom: 1 },
  );

test("视口外的节点不在 DOM 中；一端在视口外的连线照常显示；重建节点不再强制渲染已测量过的节点", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "可见", boardText: bigBoard("可见") });
  await expect(task(page, "p1")).toBeVisible();
  // 首帧强制渲染全部节点、测量后视口外的随即卸载。
  await expect.poll(() => domIds(page)).toEqual(["p1", "pNear", "t1"]);
  const cross = page.locator('.react-flow__edge[data-id="pNear:out->tFar:positive"]');
  await expect(cross).toHaveCount(1);
  await expect(cross.locator("path").first()).toHaveAttribute("d", /\S/);

  // 画布把测量结果回传给节点（xyflow#3816）：选中等重建节点的操作不会让视口外的节点被重新强制渲染。
  await page.locator(".react-flow__nodes").evaluate((root) => {
    const seen: string[] = [];
    (window as unknown as { __mounted: string[] }).__mounted = seen;
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && seen.push(n.getAttribute("data-id") ?? ""));
    }).observe(root, { childList: true });
  });
  await task(page, "p1").locator(".node-title").click();
  await expect(task(page, "p1")).toHaveClass(/selected/);
  await task(page, "t1").locator(".node-title").click();
  await expect(task(page, "t1")).toHaveClass(/selected/);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __mounted: string[] }).__mounted)).toEqual([]);

  // 平移到远处：近处的节点卸载，远处的挂载。
  await moveToBlank(page);
  await pan(page, -4000, 0);
  await expect.poll(() => domIds(page)).toEqual(["pFar", "tFar"]);
  await expect(cross).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("框选、Shift 多选、删除与 fitView 照常作用于视口外的节点", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "选区", boardText: bigBoard("选区") });
  await expect.poll(() => domIds(page)).toEqual(["p1", "pNear", "t1"]);

  // 框选近处的 p1 与 t1（左键拖空白）。
  const p1 = (await task(page, "p1").boundingBox())!;
  const t1 = (await task(page, "t1").boundingBox())!;
  await page.mouse.move(p1.x - 30, p1.y - 30);
  await page.mouse.down();
  await page.mouse.move(t1.x + t1.width / 2, p1.y + p1.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(task(page, "p1")).toHaveClass(/selected/);
  await expect(task(page, "t1")).toHaveClass(/selected/);

  // 平移到远处，Shift + 点 pFar 加选；近处已选的不在 DOM 中，仍在选区里。
  await moveToBlank(page);
  await pan(page, -4000, 0);
  await expect.poll(() => domIds(page)).toEqual(["pFar", "tFar"]);
  await task(page, "pFar").locator(".node-title").click({ modifiers: ["Shift"] });
  await expect(task(page, "pFar")).toHaveClass(/selected/);

  // 删除：三个一起删（两个不在 DOM 中）。
  await page.keyboard.press("Delete");
  await expect(task(page, "pFar")).toHaveCount(0);
  await page.waitForResponse((r) => r.url().includes("/api/boards?") && r.request().method() === "PUT" && r.status() === 204);
  expect(savedNodes(rig, "选区").map((n) => n.id).sort()).toEqual(["pNear", "tFar"]);

  // fitView（Ctrl+0）：把剩下的全部纳入视口。
  await moveToBlank(page);
  await page.mouse.click(10 + (await page.locator(".react-flow__pane").boundingBox())!.x, 300);
  await pan(page, 0, 3000);
  await expect.poll(() => domIds(page)).toEqual([]);
  await page.keyboard.press("Control+0");
  await expect.poll(() => domIds(page)).toEqual(["pNear", "tFar"]);
  expect(errors).toEqual([]);
});

test("运行指示定位到视口外的任务节点：居中挂载并选中", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "定位", boardText: bigBoard("定位") });
  let release = () => {};
  rig.stub.holdImages = new Promise((resolve) => (release = resolve));
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".run-indicator > button")).toHaveText("执行 1 · 排队 0");

  await moveToBlank(page);
  await pan(page, -4000, 0);
  await expect(task(page, "t1")).toHaveCount(0);
  await page.locator(".run-indicator > button").click();
  await page.locator(".run-list li .link").first().click();
  await expect(task(page, "t1")).toBeInViewport();
  await expect(task(page, "t1")).toHaveClass(/selected/);
  release();
  await expect(page.locator(".run-indicator")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("光标停在节点上时平移使其离开视口再回来，悬浮动作条不出现", async ({ page, rig }) => {
  const text = boardAt("动作条", [referenceNode("r1", REF, [200, 100])], [], { x: 0, y: 0, zoom: 1 });
  const errors = await openApp(page, rig, { title: "动作条", boardText: text, files: { [REF]: { b64: png(64, 64) } } });
  await task(page, "r1").locator("img.thumb").hover();
  await expect(page.locator(".action-bar")).toBeVisible();

  await pan(page, -3000, 0);
  await expect(task(page, "r1")).toHaveCount(0);
  await moveToBlank(page);
  await pan(page, 3000, 0);
  await expect(task(page, "r1")).toBeVisible();
  await expect(page.locator(".action-bar")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("提示词节点有未提交文本时平移离开再回来，文本仍在", async ({ page, rig }) => {
  const text = boardAt(
    "未提交",
    [promptNode("p1", "一只猫", [200, 100]), taskNode("t1", { last_submitted: { task_id: "20260916T000000Z-aaaa0001" } }, [600, 100])],
    [edge("p1", "t1", "positive")],
    { x: 0, y: 0, zoom: 1 },
  );
  const errors = await openApp(page, rig, { title: "未提交", boardText: text });
  const field = task(page, "p1").locator("textarea");
  await field.click();
  await field.press("End");
  await page.keyboard.type("在屋顶");
  await expect(task(page, "p1").locator(".fork-choice")).toBeVisible();

  await moveToBlank(page);
  await pan(page, -3000, 0);
  await expect(task(page, "p1")).toHaveCount(0);
  await pan(page, 3000, 0);
  await expect(field).toHaveValue("一只猫在屋顶");
  await expect(task(page, "p1").locator(".fork-choice")).toBeVisible();
  expect(errors).toEqual([]);
});

test("新建落在视口外的提示词，之后平移使其进入视口，焦点不被抢走", async ({ page, rig }) => {
  // 视口上沿在 r1 中部；以此继续编辑新建的提示词落在 r1 上方，整个在视口外。
  const text = boardAt(
    "聚焦",
    [promptNode("p0", "", [0, 400]), { ...referenceNode("r1", REF, [400, 0]), size: [300, 900] }],
    [],
    { x: 0, y: -350, zoom: 1 },
  );
  const errors = await openApp(page, rig, { title: "聚焦", boardText: text, files: { [REF]: { b64: png(64, 192) } } });
  await task(page, "r1").locator("img.thumb").click({ button: "right" });
  await page.getByRole("menuitem", { name: "以此继续编辑" }).click();
  await expect.poll(() => savedNodes(rig, "聚焦").filter((n) => n.type === "prompt").length).toBe(2);
  const created = savedNodes(rig, "聚焦").find((n) => n.type === "prompt" && n.id !== "p0")!.id;
  await expect(task(page, created)).toHaveCount(0);

  const field = task(page, "p0").locator("textarea");
  await field.click();
  await page.keyboard.type("别抢");
  await moveToBlank(page);
  await pan(page, 0, 600);
  await expect(task(page, created)).toBeVisible();
  await page.waitForTimeout(200);
  await expect(field).toBeFocused();
  await page.keyboard.type("焦点");
  await expect(field).toHaveValue("别抢焦点");
  expect(errors).toEqual([]);
});

test("新建落在视口内的提示词照常获得焦点", async ({ page, rig }) => {
  const text = boardAt("聚焦内", [referenceNode("r1", REF, [400, 0])], [], { x: 0, y: 500, zoom: 1 });
  const errors = await openApp(page, rig, { title: "聚焦内", boardText: text, files: { [REF]: { b64: png(64, 64) } } });
  await task(page, "r1").locator("img.thumb").click({ button: "right" });
  await page.getByRole("menuitem", { name: "以此继续编辑" }).click();
  await expect.poll(() => savedNodes(rig, "聚焦内").filter((n) => n.type === "prompt").length).toBe(1);
  const created = savedNodes(rig, "聚焦内").find((n) => n.type === "prompt")!.id;
  await expect(task(page, created).locator("textarea")).toBeFocused();
  expect(errors).toEqual([]);
});

test("把节点拖出画布区域时 onNodeDragStop 仍然触发（Alt + 拖复制在松手时对调）", async ({ page, rig }) => {
  const text = boardAt("拖出", [referenceNode("r1", REF, [300, 20])], [], { x: 0, y: 0, zoom: 1 });
  const errors = await openApp(page, rig, { title: "拖出", boardText: text, files: { [REF]: { b64: png(64, 64) } } });
  const box = (await task(page, "r1").boundingBox())!;
  // 抓节点下沿附近，拖到顶栏上：整个节点离开画布视口。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 80, 5, { steps: 12 });
  // 前提：拖动途中被拖的节点已离开视口、被卸载。
  await expect(task(page, "r1")).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  // 松手对调：原节点 r1 回到原处，拖走的是副本（见 useCanvasInteraction 的 Alt + 拖）。
  await expect
    .poll(() => savedNodes(rig, "拖出").map((n) => `${n.id === "r1" ? "r1" : "copy"}${n.pos[0] === 300 && n.pos[1] === 20}`).sort())
    .toEqual(["copyfalse", "r1true"]);
  expect(errors).toEqual([]);
});
