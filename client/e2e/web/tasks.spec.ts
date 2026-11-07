// 手测清单 #1–#8 与 Issue #1/#15：任务节点相关场景。
// 网关与对象存储由本机桩扮演：结果默认 url 形式，由服务端中转写进任务目录。
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { FLASH } from "../common/layers";
import { bodies, GOOD_KEY, test, type Rig } from "./rig";
import path from "node:path";
import { boardRelPath, openApp, readJson, savedNodes, task, taskRecords } from "./kit";

const builtin = JSON.parse(readFileSync(new URL("../../src/core/capabilities.builtin.json", import.meta.url), "utf8"));
const fixture = (name: string) => readFileSync(new URL(`../../src/core/__fixtures__/${name}`, import.meta.url), "utf8");

/** 能力表覆盖：按 model_id 整条替换内置模型。 */
function override(modelId: string, patch: (m: Record<string, any>) => void) {
  const model = structuredClone(builtin.models.find((m: { model_id: string }) => m.model_id === modelId));
  patch(model);
  return JSON.stringify({ format_version: builtin.format_version, models: [model] });
}

const RESULT_PNG = png(64, 64);
const recordTexts = (rig: Rig) => taskRecords(rig).map((r) => r.json);

async function openMenu(page: Page, nodeId: string, label: string) {
  await task(page, nodeId).locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: label }).click();
}

async function expand(page: Page, nodeId: string) {
  await task(page, nodeId).getByRole("button", { name: "展开" }).click();
}

const toolbarRun = (page: Page) => page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /运行/ });
const REF = "导入参考图/cat.png";

test("Issue #15 用户手动选择 Flash，设置 JPEG/水印并运行普通任务（b64_json 结果只新建写入）", async ({ page, rig }) => {
  const text = board("Flash", [promptNode("p1", "一只猫"), taskNode("t1")], [edge("p1", "t1", "positive")]);
  const errors = await openApp(page, rig, { title: "Flash", boardText: text });
  rig.stub.imageResponse = () => ({ json: { data: [{ b64_json: RESULT_PNG }] } });
  await expand(page, "t1");
  await task(page, "t1").getByRole("combobox", { name: "模型", exact: true }).selectOption(FLASH);
  await task(page, "t1").getByRole("combobox", { name: "分辨率档" }).selectOption("2K");
  await task(page, "t1").getByRole("combobox", { name: "输出格式" }).selectOption("jpeg");
  await task(page, "t1").getByRole("checkbox", { name: "水印" }).check();
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies(rig).length).toBe(1);
  expect(bodies(rig)[0]).toMatchObject({ model: FLASH, size: "2048x2048", output_format: "jpeg", watermark: true, response_format: "url", optimize_prompt_options: { mode: "standard" } });
  expect(Object.keys(bodies(rig)[0]).sort()).toEqual(["model", "optimize_prompt_options", "output_format", "prompt", "response_format", "size", "watermark"]);
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  expect(taskRecords(rig)[0].json.output_options).toEqual({ output_format: "jpeg", response_format: "url", watermark: true });
  expect(errors).toEqual([]);
});

test("Issue #32 份数控件：可选 1 到并发上限，随画板保存；超限的份数照原值保留", async ({ page, rig }) => {
  const text = board("份数", [promptNode("p1", "一只猫"), taskNode("t1"), taskNode("t2", { count: 7 }, [800, 0])], [edge("p1", "t1", "positive")]);
  const errors = await openApp(page, rig, { title: "份数", boardText: text });
  const saved = () => readJson(path.join(rig.userRoot(GOOD_KEY), boardRelPath("份数"))).nodes as { id: string; count?: number }[];
  const count = (id: string) => task(page, id).getByRole("combobox", { name: "份数" });
  await expect(count("t1")).toHaveValue("1");
  await expect(count("t1").locator("option")).toHaveText(["1", "2", "3", "4"]);
  await expect(count("t2")).toHaveValue("7");
  await count("t1").selectOption("3");
  await expect.poll(() => saved().find((n) => n.id === "t1")?.count).toBe(3);
  expect(saved().find((n) => n.id === "t2")?.count).toBe(7);
  expect(errors).toEqual([]);
});

test("Issue #34 运行按份数展开：每份一次 n: 1 请求、一个任务目录、一个结果节点", async ({ page, rig }) => {
  const text = board("份数运行", [promptNode("p1", "一只猫"), taskNode("t1", { count: 2 })], [edge("p1", "t1", "positive")]);
  const errors = await openApp(page, rig, { title: "份数运行", boardText: text });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.getByRole("dialog", { name: "确认运行" })).toHaveCount(0);
  await expect(page.locator(".react-flow__node-result")).toHaveCount(2);
  expect(bodies(rig)).toHaveLength(2);
  for (const body of bodies(rig)) expect(body).toMatchObject({ n: 1 });
  expect(new Set(taskRecords(rig).map((r) => r.json.task_id)).size).toBe(2);
  expect(errors).toEqual([]);
});

test("Issue #37 运行指示单行取消：只取消那一份，其余份继续并产出结果", async ({ page, rig }) => {
  const text = board("单份取消", [promptNode("p1", "一只猫"), taskNode("t1", { count: 2 })], [edge("p1", "t1", "positive")]);
  const errors = await openApp(page, rig, { title: "单份取消", boardText: text });
  let release = () => {};
  rig.stub.holdImages = new Promise((resolve) => (release = resolve));
  await task(page, "t1").locator(".task-actions button.primary").click();
  await page.locator(".run-indicator > button").filter({ hasText: "执行 2 · 排队 0" }).click();
  const rows = page.locator(".run-list li");
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole("button", { name: /^取消任务 / }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator(".run-indicator > button")).toHaveText("执行 1 · 排队 0");
  release();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  await expect(page.locator(".run-indicator")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Issue #35 重新生成按份数展开并二次确认；生成变体只生成一份", async ({ page, rig }) => {
  const text = board("份数重新生成", [promptNode("p1", "一只猫"), taskNode("t1", { count: 2 })], [edge("p1", "t1", "positive")]);
  const errors = await openApp(page, rig, { title: "份数重新生成", boardText: text });
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(2);
  const asked: string[] = [];
  let accept = false;
  page.on("dialog", (d) => {
    asked.push(d.message());
    void (accept ? d.accept() : d.dismiss());
  });
  await openMenu(page, "t1", "重新生成");
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain("将生成 2 份，模型 qwen-image-3.0-pro");
  expect(bodies(rig)).toHaveLength(2);
  accept = true;
  // 结果列变长后新结果可能落在视口外、不在 DOM 中（只渲染可见节点）：按画板文件计数。
  const results = () => savedNodes(rig, "份数重新生成").filter((n) => n.type === "result").length;
  await openMenu(page, "t1", "重新生成");
  await expect.poll(results).toBe(4);
  expect(bodies(rig)).toHaveLength(4);
  await page.locator(".react-flow__node-result").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "生成变体", exact: true }).click();
  await expect.poll(results).toBe(5);
  expect(bodies(rig)).toHaveLength(5);
  expect(asked).toHaveLength(2);
  expect(errors).toEqual([]);
});

test.describe("Issue #1 单图默认引用与多图点击插入引导", () => {
  const openSingleImage = async (page: Page, rig: Rig, prompt: string, files: Record<string, { b64: string }> = { [REF]: { b64: png(1024, 1024) } }, edges: unknown[] = [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]) => {
    const text = board("单图", [promptNode("p1", prompt), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })], edges);
    return openApp(page, rig, { title: "单图", boardText: text, files });
  };

  test("单图省略图1：提交发送确认补写与参考图，无未引用警告；用户提示词原文不变", async ({ page, rig }) => {
    const errors = await openSingleImage(page, rig, "把衣服改成红色");
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect(page.getByRole("dialog", { name: "确认运行" })).toHaveCount(0);
    await expect.poll(() => bodies(rig).length).toBe(1);
    const record = recordTexts(rig)[0];
    const body = bodies(rig)[0];
    expect(record.send_text).toContain("本次提供一张参考图，编号为图1。请依据图1的视觉内容执行下方用户指令；指令中省略编号的图片指代均指图1。");
    expect(record.send_text).toContain("用户指令：\n把衣服改成红色");
    expect(record.prompt).toBe("把衣服改成红色");
    expect(body.prompt).toBe(record.send_text);
    expect(body.image).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("单图风格参考：按指定用途使用图1；显式 @图2 仍硬阻断", async ({ page, rig }) => {
    const errors = await openSingleImage(page, rig, "参考这张图的风格画一座城堡");
    await openMenu(page, "t1", "查看发送文本");
    const shown = (await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent())!;
    expect(shown).toContain("用户指定参考用途时，按指定用途使用图1。用户要求修改图片时，以图1为编辑基础");
    expect(shown).toContain("用户指令：\n参考这张图的风格画一座城堡");
    await page.getByRole("button", { name: "关闭" }).click();
    expect(errors).toEqual([]);

    const out = board("越界", [promptNode("p1", "按@图2 改"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })], [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")]);
    await openApp(page, rig, { title: "越界", boardText: out, files: { [REF]: { b64: png(1024, 1024) } } });
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect(page.getByRole("dialog", { name: "确认运行" })).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("无法运行：提示词引用了图2，但只接了 1 张参考图");
  });

  test("单图带区域：单图补写与区域说明共同生效；叠加图不产生未引用警告", async ({ page, rig }) => {
    await openSingleImage(page, rig, "把区域1 改成红色", { [REF]: { b64: png(1024, 1024) } }, [
      edge("p1", "t1", "positive"),
      edge("r1", "t1", "image:0", { region: { rects: [[0.1, 0.1, 0.5, 0.5]], render: "highlight_overlay" } }),
    ]);
    await task(page, "t1").getByRole("button", { name: "展开" }).click();
    await expect(task(page, "t1").locator(".warn-list")).toHaveCount(0);
    await expect(task(page, "t1").locator(".port-unreferenced")).toHaveCount(0);
    await openMenu(page, "t1", "查看发送文本");
    const shown = (await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent())!;
    expect(shown).toContain("本次提供一张参考图，编号为图1。");
    expect(shown).toContain("用户指令：\n把紫色区域 改成红色");
    expect(shown).toContain("图2 是图1 的标注版，紫色半透明高亮标出的是要修改的区域");
  });

  test("提示词下方按任务分组展示缩略图，光标处点击插入；共享提示词分组说明与编辑选择保留", async ({ page, rig }) => {
    const ref2 = "导入参考图/dog.png";
    const text = board(
      "共享",
      [promptNode("p1", "把", [0, 0]), referenceNode("r1", REF), referenceNode("r2", ref2, [0, 400]), taskNode("t1", { image_ports: 2 }, [450, 0]), taskNode("t2", { image_ports: 1 }, [450, 430])],
      [edge("p1", "t1", "positive"), edge("p1", "t2", "positive"), edge("r1", "t1", "image:0"), edge("r2", "t1", "image:1"), edge("r2", "t2", "image:0")],
    );
    const files = { [REF]: { b64: png(1024, 1024, { rgb: [200, 30, 30] }) }, [ref2]: { b64: png(1024, 1024, { rgb: [30, 30, 220] }) } };
    const errors = await openApp(page, rig, { title: "共享", boardText: text, files });
    const prompt = page.locator('.react-flow__node[data-id="p1"]');
    await expect(prompt.getByText("此提示词供多个任务使用，图片编号按各任务的连接分别解释。")).toBeVisible();
    const groups = prompt.locator(".reference-guide-task");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toContainText("qwen-image-3.0-pro");
    await expect(groups.nth(0).getByText("点击参考图，将引用插入提示词。")).toBeVisible();
    await expect(groups.nth(0).getByRole("button", { name: /图1/ })).toBeVisible();
    await expect(groups.nth(0).getByRole("button", { name: /图2/ })).toBeVisible();
    await expect(groups.nth(1).getByRole("button", { name: /图1/ })).toBeVisible();
    await expect(prompt.locator(".reference-guide-thumb img")).toHaveCount(3);

    const textarea = prompt.locator("textarea");
    await textarea.click();
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(2, 2));
    await groups.nth(0).getByRole("button", { name: /图2/ }).click();
    await expect(textarea).toHaveValue("把@图2");
    await expect.poll(async () => textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(4);
    await expect(groups.nth(0)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("多图未引用警告包含插入引用与描述用途的引导；叠加图不作为可点击参考图", async ({ page, rig }) => {
    const ref2 = "导入参考图/dog.png";
    const text = board(
      "多图",
      [promptNode("p1", "把图1 调亮"), referenceNode("r1", REF), referenceNode("r2", ref2, [0, 400]), taskNode("t1", { image_ports: 2, transparent_background: true })],
      [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0"), edge("r2", "t1", "image:1", { region: { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" } })],
    );
    const files = { [REF]: { b64: png(1024, 1024) }, [ref2]: { b64: png(1024, 1024) } };
    await openApp(page, rig, { title: "多图", boardText: text, files });
    await task(page, "t1").locator(".node-task").hover();
    await task(page, "t1").getByRole("button", { name: "展开" }).click();
    await expect(task(page, "t1").locator(".error-list")).toContainText("模型不支持透明背景");
    const guide = page.locator('.react-flow__node[data-id="p1"] .reference-guide-task');
    await expect(guide.getByRole("button")).toHaveCount(2);
    await expect(guide.getByRole("button", { name: /图2/ }).locator(".reference-guide-rect")).toHaveCount(1);
  });

  test("重新生成按当前单图规则重算：请求、展示与任务记录一致", async ({ page, rig }) => {
    const errors = await openSingleImage(page, rig, "把衣服改成红色");
    await task(page, "t1").locator(".task-actions button.primary").click();
    await expect.poll(() => bodies(rig).length).toBe(1);
    await openMenu(page, "t1", "重新生成");
    await expect.poll(() => bodies(rig).length).toBe(2);
    expect(bodies(rig)[1].prompt).toBe(bodies(rig)[0].prompt);
    await openMenu(page, "t1", "查看发送文本");
    const shown = (await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent())!;
    expect(shown).toBe(bodies(rig)[1].prompt);
    expect(taskRecords(rig).length).toBe(2);
    expect(new Set(recordTexts(rig).map((r) => r.send_text)).size).toBe(1);
    expect(errors).toEqual([]);
  });
});

test("#1 带区域的图片编辑：查看发送文本、task.json 的 send_text、请求文本三者一致", async ({ page, rig }) => {
  const text = board(
    "区域",
    [promptNode("p1", "把图1里的猫换成狗"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })],
    [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0", { region: { rects: [[0.1, 0.1, 0.5, 0.5]], render: "highlight_overlay" } })],
  );
  const errors = await openApp(page, rig, { title: "区域", boardText: text, files: { [REF]: { b64: png(1024, 1024) } } });

  await openMenu(page, "t1", "查看发送文本");
  const dialog = page.getByRole("dialog", { name: "查看发送文本" });
  const shown = (await dialog.locator("pre.send-text").first().textContent())!;
  expect(shown).toContain("把图1里的猫换成狗");
  expect(shown).toContain("高亮");
  await dialog.getByRole("button", { name: "关闭" }).click();

  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies(rig).length).toBe(1);
  await expect.poll(() => taskRecords(rig).length).toBe(1);
  const record = recordTexts(rig)[0];
  const body = bodies(rig)[0];
  const images = body.image ?? [];

  expect(record.send_text).toBe(shown);
  expect(body.prompt).toBe(shown);
  // 叠加图紧随原图：顶层 image 按序 2 张参考图，文本只走 prompt。
  expect(images).toHaveLength(2);
  expect(images.every((i) => i.startsWith("data:image/"))).toBe(true);
  expect(images[0]).not.toBe(images[1]);
  expect(body.input).toBeUndefined();
  expect(errors).toEqual([]);
});

test("#2 模型不在能力表内：二次确认与查看发送文本显示「模型不可用，无法生成发送文本」", async ({ page, rig }) => {
  const text = board(
    "下架",
    [promptNode("p1", "一只猫"), taskNode("gone", { model: "retired-model" }), promptNode("p2", "一只狗", [0, 500]), taskNode("ok", {}, [400, 500])],
    [edge("p1", "gone", "positive"), edge("p2", "ok", "positive")],
  );
  await openApp(page, rig, { title: "下架", boardText: text });

  await toolbarRun(page).click();
  const confirm = page.getByRole("dialog", { name: "确认运行" });
  const bad = confirm.locator("li.confirm-bad");
  await expect(bad).toHaveCount(1);
  await bad.getByRole("button", { name: "展开完整发送文本" }).click();
  await expect(bad.locator("pre.send-text")).toHaveText("模型不可用，无法生成发送文本");
  await expect(bad.locator("input[type=checkbox]")).toBeDisabled();
  await confirm.getByRole("button", { name: "取消" }).click();

  await openMenu(page, "gone", "查看发送文本");
  await expect(page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text")).toHaveText("模型不可用，无法生成发送文本");
});

test("#3 新建空任务不标红（未就绪）", async ({ page, rig }) => {
  await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: /生成任务/ }).click();
  const node = page.locator(".node-task");
  await expect(node).toHaveCount(1);
  await expect(node).not.toHaveClass(/node-error/);
  if (await node.getByRole("button", { name: "展开" }).count()) await node.getByRole("button", { name: "展开" }).click();
  await expect(node.locator("ul.hint-list")).toBeVisible();
  await expect(node.locator("ul.error-list")).toHaveCount(0);
});

test("#4 选请求形态未接入的模型：节点标红并列出原因", async ({ page, rig }) => {
  const text = board("形态", [promptNode("p1", "一只猫"), taskNode("t1")], [edge("p1", "t1", "positive")]);
  await openApp(page, rig, { title: "形态", boardText: text, capabilityOverride: override("qwen-image-3.0", (m) => (m.request_shape = "future_shape")) });
  await expand(page, "t1");
  await expect(task(page, "t1").locator(".node-task")).not.toHaveClass(/node-error/);
  await task(page, "t1").getByLabel("模型", { exact: true }).selectOption("qwen-image-3.0");
  await expect(task(page, "t1").locator(".node-task")).toHaveClass(/node-error/);
  await expect(task(page, "t1").locator("ul.error-list")).toContainText("请求形态尚未接入");
});

test("#5 英文提示词 + 参考图 + 英文序号未验证：黄色提示，不标红，运行进二次确认", async ({ page, rig }) => {
  const text = board(
    "英文",
    [promptNode("p1", "Replace the cat in image 1 with a dog"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 })],
    [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")],
  );
  await openApp(page, rig, {
    title: "英文",
    boardText: text,
    files: { [REF]: { b64: png(1024, 1024) } },
    capabilityOverride: override("qwen-image-3.0-pro", (m) => (m.reference_phrasing.en_verified = "untested")),
  });
  await expand(page, "t1");
  const node = task(page, "t1");
  await expect(node.locator("ul.warn-list")).toContainText("该模型英文序号未验证");
  await expect(node.locator(".node-task")).not.toHaveClass(/node-error/);
  await node.locator(".task-actions button.primary").click();
  const confirm = page.getByRole("dialog", { name: "确认运行" });
  await expect(confirm.locator("ul.warn-list")).toContainText("该模型英文序号未验证");
  await expect(confirm.getByRole("button", { name: "运行 1 个任务" })).toBeEnabled();
});

test("#36 份数超过并发上限：节点与确认窗同一条黄色提示，不标红，仍可运行", async ({ page, rig }) => {
  const text = board("份数", [promptNode("p1", "一只猫"), taskNode("t1", { count: 6 })], [edge("p1", "t1", "positive")]);
  await openApp(page, rig, { title: "份数", boardText: text });
  await expand(page, "t1");
  const node = task(page, "t1");
  await expect(node.locator("ul.warn-list")).toContainText("份数 6，本次按 4");
  await expect(node.locator(".node-task")).not.toHaveClass(/node-error/);
  await node.locator(".task-actions button.primary").click();
  const confirm = page.getByRole("dialog", { name: "确认运行" });
  await expect(confirm.locator("ul.warn-list")).toContainText("份数 6，本次按 4");
  await expect(confirm.getByRole("button", { name: "运行 1 个任务" })).toBeEnabled();
});

test.describe("#6 透明背景开关", () => {
  const SEEDREAM = "doubao-seedream-5-0-pro-260628";
  const OPAQUE = "导入参考图/opaque.png";
  const ALPHA = "导入参考图/alpha.png";
  const files = { [OPAQUE]: { b64: png(1024, 1024) }, [ALPHA]: { b64: png(1024, 1024, { alpha: true }) } };

  async function open(page: Page, rig: Rig, refList: string[], over: Record<string, unknown> = {}) {
    const nodes = [promptNode("p1", "一只猫"), ...refList.map((r, i) => referenceNode(`r${i}`, r, [0, 200 + i * 220])), taskNode("t1", { model: SEEDREAM, image_ports: refList.length, ...over })];
    const edges = [edge("p1", "t1", "positive"), ...refList.map((_, i) => edge(`r${i}`, "t1", `image:${i}`))];
    await openApp(page, rig, { title: "透明", boardText: board("透明", nodes, edges), files });
    await expand(page, "t1");
    const label = task(page, "t1").locator(".toggles label", { hasText: "透明背景" });
    return { label, box: label.locator("input[type=checkbox]"), node: task(page, "t1").locator(".node-task") };
  }

  test("0 条或 2 条图片线：置灰并提示", async ({ page, rig }) => {
    for (const refList of [[], [ALPHA, ALPHA]]) {
      const { label, box } = await open(page, rig, refList);
      await expect(box, `${refList.length} 条图片线`).toBeDisabled();
      await expect(label, `${refList.length} 条图片线`).toHaveClass(/disabled/);
      await expect(label, `${refList.length} 条图片线`).toContainText("需要恰好一条图片线");
    }
  });

  test("源图无透明通道：置灰并提示", async ({ page, rig }) => {
    const { label, box } = await open(page, rig, [OPAQUE]);
    await expect(label).toContainText("该图不带透明通道");
    await expect(box).toBeDisabled();
  });

  test("源图有透明通道：可打开，不标红", async ({ page, rig }) => {
    const { label, box, node } = await open(page, rig, [ALPHA]);
    await expect(box).toBeEnabled();
    await expect(label).not.toHaveClass(/disabled/);
    await box.check();
    await expect(box).toBeChecked();
    await expect(node).not.toHaveClass(/node-error/);
  });

  test("打开后条件变坏：保留打开、仍可关、标红列原因", async ({ page, rig }) => {
    const { box, node } = await open(page, rig, [OPAQUE], { transparent_background: true });
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await expect(node).toHaveClass(/node-error/);
    await expect(node.locator("ul.error-list")).toContainText("该图不带透明通道");
  });
});

test("#7 单个标红任务点运行：toast「无法运行：…」", async ({ page, rig }) => {
  const text = board("标红", [promptNode("p1", "一只猫"), taskNode("t1", { model: "retired-model" })], [edge("p1", "t1", "positive")]);
  await openApp(page, rig, { title: "标红", boardText: text });
  await toolbarRun(page).click();
  await expect(page.locator(".toast")).toHaveText("无法运行：模型 retired-model 不在能力表内");
});

test.describe("#8 旧任务「重新生成」", () => {
  for (const name of ["pre-113.task.json", "pre-116.task.json"]) {
    test(name, async ({ page, rig }) => {
      const old = JSON.parse(fixture(name));
      const dir = `2026-09-16/${old.task_id}`;
      const snapshot = png(1024, 1024);
      const files = Object.fromEntries([[`${dir}/task.json`, { text: fixture(name) }], ...old.references.map((r: { file: string }) => [`${dir}/${r.file}`, { b64: snapshot }])]);
      const text = board(
        "重生成",
        [promptNode("p1", old.prompt), taskNode("t1", { image_ports: 2, last_submitted: { task_id: old.task_id } })],
        [edge("p1", "t1", "positive")],
      );
      const errors = await openApp(page, rig, { title: "重生成", boardText: text, files });

      await openMenu(page, "t1", "重新生成");
      await expect.poll(() => bodies(rig).length).toBe(1);
      await expect.poll(() => taskRecords(rig).length).toBe(2);
      const record = taskRecords(rig).find((r) => !r.path.includes(old.task_id))!.json;
      const body = bodies(rig)[0];
      expect(body.prompt).toBe(record.send_text);
      expect(body.input).toBeUndefined();
      // 快照原样重发：顶层 image 3 张（含叠加图）。
      expect(body.image).toHaveLength(3);
      expect(record.prompt).toBe(old.prompt);
      if (name === "pre-116.task.json") expect(record.send_text).toBe(old.send_text);
      await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
});
