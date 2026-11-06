// 文生图结果中转与任务状态：结果由服务端写入任务目录、失败与中断的如实呈现、按用户隔离。
// 同时承载旧假壳 misc.spec 的 #17–#20（运行前判定与重开后的已存状态）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { enterWithKey, GOOD_KEY, OTHER_KEY, test } from "./rig";
import { openApp, task, taskRecords } from "./kit";

const REF = "导入参考图/cat.png";
const singleImage = (prompt = "把衣服改成红色") =>
  board("文生图", [promptNode("p1", prompt), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]);
const files = { [REF]: { b64: png(1024, 1024) } };

test("url 结果由服务端中转写入任务目录，刷新后结果节点仍在；对象存储不带 CORS", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "文生图", boardText: singleImage(), files });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  const record = taskRecords(rig)[0];
  const dir = path.dirname(record.path);
  expect(existsSync(path.join(dir, "result.png"))).toBe(true);
  expect(existsSync(path.join(dir, ".staging"))).toBe(false, "提交后不留暂存区");
  // 浏览器没有直接跨域取对象存储：桩的 /objects/* 响应不带 CORS，结果图由 <img> 靠 cookie 从服务端加载。
  const src = await page.locator(".react-flow__node-result img").first().getAttribute("src");
  expect(src).toContain("/api/fs/thumb?path=");
  await page.reload();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  await expect(task(page, "t1").locator(".status")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("下载失败：任务按失败处理，不换模型不重发，不留成品", async ({ page, rig }) => {
  rig.stub.objects.clear();
  await openApp(page, rig, { title: "文生图", boardText: singleImage(), files });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(task(page, "t1").locator(".status-failed")).toContainText("失败");
  await expect(page.locator(".react-flow__node-result")).toHaveCount(0);
  expect(rig.stub.requests).toHaveLength(1);
  const dir = path.dirname(taskRecords(rig)[0].path);
  expect(readdirSync(dir)).not.toContain("result.png");
  expect(existsSync(path.join(dir, ".staging"))).toBe(false);
  expect(JSON.parse(readFileSync(path.join(dir, "outcome.json"), "utf8")).outcome).toBe("failed");
});

test("对象存储返回 401：任务失败并如实显示上游状态，不踢回粘贴密钥界面", async ({ page, rig }) => {
  rig.stub.objectStatus = 401;
  await openApp(page, rig, { title: "文生图", boardText: singleImage(), files });
  await task(page, "t1").locator(".task-actions button.primary").click();
  const failed = task(page, "t1").locator(".status-failed");
  await expect(failed).toContainText("失败");
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "进入工作台" })).toHaveCount(0);
  await expect(page.locator(".react-flow__node-result")).toHaveCount(0);
  expect(JSON.parse(readFileSync(path.join(path.dirname(taskRecords(rig)[0].path), "outcome.json"), "utf8")).outcome).toBe("failed");
  expect(await page.evaluate(() => fetch("/api/session").then((r) => r.status))).toBe(200);
});

test("结果地址不在允许列表：400 拒绝，任务失败且不写文件", async ({ page, rig }) => {
  rig.stub.imageResponse = (_path, body) =>
    String(body.model ?? "").startsWith("doubao")
      ? { json: { data: [{ url: "https://example.com/x.png?sig=abc" }] } }
      : { json: { metadata: { output: { choices: [{ message: { content: [{ image: "https://example.com/x.png?sig=abc" }] } }] } } } };
  await openApp(page, rig, { title: "文生图", boardText: singleImage(), files });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(task(page, "t1").locator(".status-failed")).toContainText("失败");
  await expect(page.locator(".react-flow__node-result")).toHaveCount(0);
  expect(rig.stub.requests).toHaveLength(1);
  const dir = path.dirname(taskRecords(rig)[0].path);
  expect(readdirSync(dir)).toEqual(expect.arrayContaining(["task.json", "outcome.json"]));
  expect(readdirSync(dir).some((n) => n.startsWith("result."))).toBe(false);
});

test("另一把密钥看不到这份画板与结果（按用户隔离）", async ({ page, rig, browser }) => {
  await openApp(page, rig, { title: "文生图", boardText: singleImage(), files });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await enterWithKey(page2, rig.baseURL, OTHER_KEY);
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  await page2.getByRole("button", { name: "画板列表", exact: true }).click();
  const list = page2.getByRole("dialog", { name: "画板列表" });
  await expect(list.locator("ul.board-list li")).toHaveCount(1, "另一把密钥只有它自己新建的空画板");
  await expect(list.getByRole("button", { name: "文生图", exact: true })).toHaveCount(0);
  expect(existsSync(path.join(rig.userRoot(OTHER_KEY), "画板", "文生图.ugcboard.json"))).toBe(false);
  const resultRel = path.relative(rig.userRoot(GOOD_KEY), path.join(path.dirname(taskRecords(rig)[0].path), "result.png")).replace(/\\/g, "/");
  const denied = await page2.request.get(`${rig.localURL}/api/fs/file?path=${encodeURIComponent(resultRel)}`);
  expect(denied.status()).toBe(401, "不带会话读不到文件");
  await other.close();
});

test("#17 参考图文件缺失：节点标红，运行提示无法运行", async ({ page, rig }) => {
  const text = board("缺图", [promptNode("p1", "把图1变成水彩"), referenceNode("r1", "导入参考图/不存在.png"), taskNode("t1", { image_ports: 1 })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]);
  await openApp(page, rig, { title: "缺图", boardText: text });
  await expect(task(page, "r1")).toContainText("图片缺失");
  await expect(task(page, "t1").locator(".node-task")).toHaveClass(/node-error/);
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("无法运行：图1 图片缺失");
  expect(taskRecords(rig)).toEqual([]);
});

test("#18 透明背景 + 源图不带透明通道：节点标红，运行被拦；带透明通道的对照不拦", async ({ page, rig }) => {
  const opaque = png(64, 64);
  const text = board("透明", [promptNode("p1", "抠出主体"), referenceNode("r1", "导入参考图/opaque.png"), taskNode("t1", { model: "doubao-seedream-5-0-pro-260628", image_ports: 1, transparent_background: true })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]);
  await openApp(page, rig, { title: "透明", boardText: text, files: { "导入参考图/opaque.png": { b64: opaque } } });
  await expect(task(page, "t1").locator(".node-task")).toHaveClass(/node-error/);
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("透明通道");
  expect(taskRecords(rig)).toEqual([]);
});

test("#18 对照：源图带透明通道时不因透明通道被拦", async ({ page, rig }) => {
  const alpha = png(64, 64, { alpha: true });
  const ok = board("透明ok", [promptNode("p1", "抠出主体"), referenceNode("r1", "导入参考图/alpha.png"), taskNode("t1", { model: "doubao-seedream-5-0-pro-260628", image_ports: 1, transparent_background: true })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]);
  await openApp(page, rig, { title: "透明ok", boardText: ok, files: { "导入参考图/alpha.png": { b64: alpha } } });
  await expect(task(page, "r1").locator("img.thumb")).toBeVisible();
  await expect(task(page, "t1").locator(".node-task")).not.toHaveClass(/node-error/);
});

test.describe("#19 / #20 重开画板后的已存状态", () => {
  const ids = { failed: "20260915T010101Z-aaaa0001", cancelled: "20260915T010102Z-aaaa0002", interrupted: "20260915T010103Z-aaaa0003" };
  const title = "已存状态";
  const outcome = (id: string, record: object) => ({ [`2026-09-15/${id}/outcome.json`]: { text: JSON.stringify(record) } });
  const text = board(
    title,
    [taskNode("tf", { last_submitted: { task_id: ids.failed } }, [0, 0]), taskNode("tc", { last_submitted: { task_id: ids.cancelled } }, [400, 0]), taskNode("ti", { last_submitted: { task_id: ids.interrupted } }, [800, 0])],
    [],
  );
  const scenario = { title, boardText: text, files: { ...outcome(ids.failed, { outcome: "failed", label: "鉴权失败" }), ...outcome(ids.cancelled, { outcome: "cancelled", gateway_may_continue: false }) } };

  const expectBadges = async (page: import("@playwright/test").Page) => {
    await expect(task(page, "tf").locator(".status-failed")).toHaveText("失败 · 鉴权失败");
    await expect(task(page, "tc").locator(".status")).toHaveText("已取消");
    await expect(task(page, "ti").locator(".status")).toHaveText("已中断");
  };
  /** 桌面版靠第二实例重新打开；Web 版从服务端画板列表打开。 */
  const reopen = async (page: import("@playwright/test").Page) => {
    await page.locator(".tab", { hasText: title }).locator(".tab-close").click();
    await expect(page.locator(".tab", { hasText: title })).toHaveCount(0);
    await page.getByRole("button", { name: "画板列表", exact: true }).click();
    await page.getByRole("dialog", { name: "画板列表" }).getByRole("button", { name: title, exact: true }).click();
    await expect(page.locator(".tab", { hasText: title })).toHaveCount(1);
  };

  test("#19 启动与关掉再打开后都显示 失败 / 已取消 / 已中断", async ({ page, rig }) => {
    await openApp(page, rig, scenario);
    await expectBadges(page);
    await reopen(page);
    await expectBadges(page);
  });

  test("#20 已中断的日志只记一次（反复关开画板）", async ({ page, rig }) => {
    await openApp(page, rig, scenario);
    await expectBadges(page);
    for (let i = 0; i < 3; i++) {
      await reopen(page);
      await expectBadges(page);
    }
    const log = readFileSync(path.join(rig.userRoot(GOOD_KEY), ".kacha", "diagnostics.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const interrupted = log.filter((l) => l.event === "task" && l.to_status === "interrupted").map((l) => ({ task_id: l.task_id, board_file: l.board_file, task_node_id: l.task_node_id, from_status: l.from_status, to_status: l.to_status }));
    expect(interrupted).toEqual([{ task_id: ids.interrupted, board_file: expect.any(String), task_node_id: "ti", from_status: "running", to_status: "interrupted" }]);
  });

  test("#38 多份：按各份任务目录推导并聚合为计数摘要，悬停显示每份的失败原因", async ({ page, rig }) => {
    const copies = { failed: "20260915T020101Z-bbbb0001", timeout: "20260915T020102Z-bbbb0002", interrupted: "20260915T020103Z-bbbb0003" };
    const multi = board(
      "多份已存状态",
      [taskNode("tm", { count: 3, last_submitted: { task_id: copies.interrupted, copy_task_ids: Object.values(copies) } })],
      [],
    );
    await openApp(page, rig, {
      title: "多份已存状态",
      boardText: multi,
      files: { ...outcome(copies.failed, { outcome: "failed", label: "鉴权失败" }), ...outcome(copies.timeout, { outcome: "failed", label: "网关超时" }) },
    });
    const badge = task(page, "tm").locator(".status-failed");
    await expect(badge).toHaveText("失败 2 · 已中断 1");
    await expect(badge).toHaveAttribute("title", "失败 · 鉴权失败\n失败 · 网关超时\n已中断");
  });

  test("结局记录读失败（5xx）不显示已中断，恢复后能读到真实状态", async ({ page, rig }) => {
    await page.route("**/api/fs/file?*", (route) => (decodeURIComponent(route.request().url()).includes("outcome.json") ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "io", message: "磁盘错误（模拟）" }) }) : route.continue()));
    await openApp(page, rig, scenario);
    await expect(task(page, "ti").locator(".node-task")).toBeVisible();
    await expect(task(page, "ti").locator(".status")).toHaveCount(0);
    await expect(task(page, "tf").locator(".status")).toHaveCount(0);
    await page.unroute("**/api/fs/file?*");
    await reopen(page);
    await expectBadges(page);
  });

  test("已中断的任务可以重新生成", async ({ page, rig }) => {
    const fixtureName = "pre-116.task.json";
    const old = JSON.parse(readFileSync(new URL(`../../src/core/__fixtures__/${fixtureName}`, import.meta.url), "utf8"));
    const dir = `2026-09-16/${old.task_id}`;
    const snapshot = png(1024, 1024);
    const seedFiles = Object.fromEntries([[`${dir}/task.json`, { text: readFileSync(new URL(`../../src/core/__fixtures__/${fixtureName}`, import.meta.url), "utf8") }], ...old.references.map((r: { file: string }) => [`${dir}/${r.file}`, { b64: snapshot }])]);
    const text = board("中断重跑", [promptNode("p1", old.prompt), taskNode("t1", { image_ports: 2, last_submitted: { task_id: old.task_id } })], [edge("p1", "t1", "positive")]);
    await openApp(page, rig, { title: "中断重跑", boardText: text, files: seedFiles });
    await expect(task(page, "t1").locator(".status")).toHaveText("已中断");
    await task(page, "t1").locator(".node-title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "重新生成" }).click();
    await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
    expect(taskRecords(rig).length).toBe(2);
  });
});
