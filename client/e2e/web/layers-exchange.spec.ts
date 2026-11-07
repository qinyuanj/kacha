// 图层交换与来源图层（画板包往返场景见 packs.spec.ts）。
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { board, edge, png, promptNode, taskNode } from "../common/boards";
import { unzip } from "../common/zip";
import { BASE, boardWithResult, BOX1, BOX2, DIR, FLASH, flashResult, L2, TASK_ID, taskFiles } from "../common/layers";
import { GOOD_KEY, test } from "./rig";
import { openApp, task, taskRecords } from "./kit";

/** 双击结果节点缩略图打开预览。 */
async function openPreview(page: Page, nodeId: string) {
  await page.locator(`.react-flow__node[data-id="${nodeId}"] img.thumb`).dblclick();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** 点「保存全部图层 + layers.json」，读回下载的 zip 条目。 */
async function downloadLayers(page: Page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存全部图层 + layers.json" }).click();
  const saved = await download;
  return unzip(readFileSync((await saved.path())!));
}

test("图层下载：zip 内含底图 + layers/ 图层 + 完整元数据 layers.json（真源含底图与名称 / 描述）", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "图层", boardText: boardWithResult("图层"), files: taskFiles() });
  await openPreview(page, "res");
  // 侧栏露出两层（打开时已按 layers.json 真源还原）。
  await expect(page.getByRole("dialog").locator(".layer-list li")).toHaveCount(2);
  const entries = await downloadLayers(page);
  expect(entries.map((e) => e.name)).toEqual(["layers.json", "layers/01.png", "layers/02.png", "result.png"]);
  expect(JSON.parse(entries[0].bytes.toString("utf8"))).toEqual({
    base: { z_index: 0, name: "合成底图", description: "底图说明" },
    layers: [
      { file: "layers/01.png", z_index: 1, bounding_box: BOX1, name: "主体", description: "红色层" },
      { file: "layers/02.png", z_index: 2, bounding_box: BOX2, name: "点缀", description: "绿色层" },
    ],
  });
  expect(entries[3].bytes).toEqual(Buffer.from(BASE, "base64"));
  expect(errors).toEqual([]);
});

test("缺图层文件 / 无效来源图层身份：明确阻断运行，不回落底图、不发送请求", async ({ page, rig }) => {
  const mk = (sourceLayer: number) =>
    board("阻断", [promptNode("p1", "改一改"), flashResult("res", [0, 300]), taskNode("t1", { model: FLASH, image_ports: 1 })], [
      edge("p1", "t1", "positive"),
      edge("res", "t1", "image:0", { source_layer: sourceLayer }),
    ]);
  await openApp(page, rig, { title: "阻断", boardText: mk(2), files: taskFiles(false) });
  await task(page, "t1").getByRole("button", { name: "展开" }).click();
  await expect(task(page, "t1")).toContainText("图1 图片缺失：result.png 图层2");
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("无法运行");
  expect(rig.stub.requests).toHaveLength(0);

  // 图层身份越界（只有 2 层接图层5）：明确报无效身份
  await openApp(page, rig, { title: "阻断", boardText: mk(5), files: taskFiles() });
  await task(page, "t1").getByRole("button", { name: "展开" }).click();
  await expect(task(page, "t1")).toContainText("图1 来源图层无效：result.png 图层5");
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("无法运行");
  expect(rig.stub.requests).toHaveLength(0);
});

test("旧结果兼容：无 layers.json、旧版四元数组 bbox 的 Flash 结果照常打开、预览与下载", async ({ page, rig }) => {
  const legacy = {
    ...flashResult("res"),
    layer_count: 1,
    record: { ...flashResult("res").record, layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [0, 0, 64, 64] }] },
  };
  const files = { [`${DIR}/task.json`]: taskFiles()[`${DIR}/task.json`], [`${DIR}/result.png`]: { b64: BASE }, [`${DIR}/layers/01.png`]: { b64: png(64, 64, { alpha: true }) } };
  const errors = await openApp(page, rig, { title: "旧", boardText: board("旧", [legacy], []), files });
  await openPreview(page, "res");
  await expect(page.getByRole("dialog").locator(".layer-list li")).toHaveCount(1);
  const entries = await downloadLayers(page);
  // 旧结果没有 layers.json 真源：包里只有底图与图层文件，元数据由前端节点记录呈现。
  expect(entries.map((e) => e.name)).toEqual(["layers/01.png", "result.png"]);
  expect(errors).toEqual([]);
});

test("来源图层继续创作：连线带图层身份，提交发送所选图层实际字节，谱系指向产出处", async ({ page, rig }) => {
  const text = board("图层创作", [promptNode("p1", "改成蓝色"), flashResult("res", [0, 300]), taskNode("t1", { model: FLASH, image_ports: 1 })], [edge("p1", "t1", "positive")]);
  await openApp(page, rig, { title: "图层创作", boardText: text, files: taskFiles() });
  rig.stub.imageResponse = () => ({ json: { data: [{ b64_json: png(64, 64) }] } });
  // 先选中目标任务（点标题栏避开输入控件），再按 Shift 多选键双击结果缩略图打开预览（不挤掉任务选区）。
  await task(page, "t1").locator(".task-title span").first().click();
  await page.locator(`.react-flow__node[data-id="res"] img.thumb`).dblclick({ modifiers: ["Shift"] });
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("combobox").selectOption("2");
  await page.getByRole("dialog").getByRole("button", { name: "加为参考图" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => {
    const text = readFileSync(`${rig.userRoot(GOOD_KEY)}/画板/图层创作.ugcboard.json`, "utf8");
    return (JSON.parse(text).edges as { source_layer?: number }[]).some((e) => e.source_layer === 2);
  }).toBe(true);
  await task(page, "t1").locator(".task-actions button.primary").click();
  await expect.poll(() => rig.stub.requests.length).toBe(1);
  expect(rig.stub.requests[0].body.image).toEqual([`data:image/png;base64,${L2}`]);
  const record = taskRecords(rig).find((r) => r.json.task_id !== TASK_ID)!.json;
  expect(record.references[0].source).toEqual({ kind: "result", task_id: TASK_ID, file: "result.png", source_layer: 2 });
});
