// Lite 停用：普通打开画板时的历史入口拦截与模型切换。
import { expect } from "@playwright/test";
import { board, edge, png, promptNode, taskNode } from "../common/boards";
import { FLASH } from "../common/layers";
import { bodies, enterWithKey, OTHER_KEY, test } from "./rig";
import { openApp, task, taskRecords } from "./kit";

const LITE = "doubao-seedream-5-0-lite-260128";
const ID = "20260916T091500Z-deadbeef";
const DIR = `2026-09-16/${ID}`;
const size = { tier: "3K", ratio: "1:1", width: null, height: null };
const record = { task_id: ID, submitted_at: "2026-09-16T09:15:00Z", workflow: "text_to_image", model: LITE, capability_format_version: 1, capability_table_sha256: "a".repeat(64), prompt: "旧猫", negative_prompt: "", send_text: "旧猫", size_spec: size, size: { width: 3072, height: 3072 }, layer_decomposition: false, transparent_background: false, references: [] };
const last = { task_id: ID, model: LITE, prompt: "旧猫", negative_prompt: "", size_spec: size, images: [], layer_decomposition: false, transparent_background: false };
const oldBoard = () =>
  board(
    "旧Lite",
    [
      promptNode("p", "一只猫"),
      taskNode("t", { model: LITE, size_spec: size, last_submitted: last }),
      { id: "r", type: "result", pos: [850, 0], size: [200, 220], task_id: ID, file: "result.png", path: `${DIR}/result.png`, layer_count: 0, record: { model: LITE, prompt: "旧猫", negative_prompt: "", size_spec: size, submitted_at: record.submitted_at } },
    ],
    [edge("p", "t", "positive"), edge("t", "r", "in", { system: true, from: ["t", "result"] })],
  );
const files = { [`${DIR}/task.json`]: { text: JSON.stringify(record) }, [`${DIR}/result.png`]: { b64: png(1024, 1024) } };

test("Lite 普通打开：阻止所有历史入口，手动切换只创建新 Flash 任务", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "旧Lite", boardText: oldBoard(), files });
  const toast = page.locator(".toast");
  await expect(task(page, "t")).toBeVisible();
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(toast).toContainText("Lite 已停用，请切换到 Flash");
  if (await task(page, "t").getByRole("button", { name: "展开" }).count()) await task(page, "t").getByRole("button", { name: "展开" }).click();
  const select = task(page, "t").getByRole("combobox", { name: "模型", exact: true });
  await expect(select).toHaveValue(LITE);
  await expect(select.locator(`option[value='${LITE}']`)).toBeDisabled();
  await task(page, "r").click({ button: "right" });
  await page.getByRole("menuitem", { name: "以此继续编辑", exact: true }).click();
  await expect(page.locator(".react-flow__node-task").filter({ hasText: "Lite（已停用" })).toHaveCount(2);
  // 继续编辑把焦点移到新节点，原任务节点自动收起；重新展开后再切换模型。
  if (await task(page, "t").getByRole("button", { name: "展开" }).count()) await task(page, "t").getByRole("button", { name: "展开" }).click();
  await task(page, "t").getByRole("combobox", { name: "模型", exact: true }).selectOption(FLASH);
  // 3K remains invalid, requiring the user's explicit adjustment.
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(toast).toContainText("生成尺寸 3K · 1:1 不在模型尺寸表内");
  expect(bodies(rig)).toHaveLength(0);
  await task(page, "t").getByRole("combobox", { name: "分辨率档" }).selectOption("2K");
  await task(page, "t").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "重新生成", exact: true }).click();
  await expect(toast).toContainText("Lite 已停用，请切换到 Flash");
  await task(page, "r").click({ button: "right" });
  await page.getByRole("menuitem", { name: "生成变体", exact: true }).click();
  await expect(toast).toContainText("Lite 已停用，请切换到 Flash");
  expect(bodies(rig)).toHaveLength(0);
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect.poll(() => bodies(rig).length).toBe(1);
  expect(bodies(rig)[0]).toMatchObject({ model: FLASH, size: "2048x2048" });
  const saved = taskRecords(rig).map((r) => r.json);
  expect(saved.some((r) => r.task_id === ID && r.model === LITE), "旧任务记录原样保留").toBe(true);
  expect(saved.filter((r) => r.model === FLASH)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("缺 Flash 缓存先刷新，失败明确不可用，用户可显式选择其它模型", async ({ page, rig }) => {
  const scenario = { title: "缺Flash", boardText: board("缺Flash", [promptNode("p", "猫")], []), modelsCache: JSON.stringify({ base_url: rig.stub.url, fetched_at: "old", model_ids: ["qwen-image-3.0"] }) };
  // 缓存里只有旧模型，进入即刷新；网关 500 让刷新失败，Flash 明确标为不可用。
  await page.route(`${rig.stub.url}/v1/models`, (route) => route.fulfill({ status: 500, body: "unavailable", headers: { "Access-Control-Allow-Origin": "*" } }));
  await openApp(page, rig, scenario);
  const select = page.getByRole("combobox", { name: "新建任务模型" });
  await expect(select).toHaveValue(FLASH);
  await expect(select.locator("option:checked")).toHaveText("Flash 不可用，请刷新模型列表");
  await select.selectOption("qwen-image-3.0");
  await expect(select).toHaveValue("qwen-image-3.0");
  expect(await select.locator(`option[value='${LITE}']`).count()).toBe(0);
});

test("Lite 画板包导入：导出的真包导入到另一把密钥后，仍阻止运行并提示切换 Flash", async ({ page, rig, browser }) => {
  await openApp(page, rig, { title: "旧Lite", boardText: oldBoard(), files });
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导出画板包…" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "画板包" }).getByRole("button", { name: "导出并下载…" }).click();
  const pack = await downloading;
  const file = (await pack.path())!;

  // 另一把密钥 = 另一个用户：空数据根，只有导入来的画板。
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await enterWithKey(page2, rig.baseURL, OTHER_KEY);
  const chooser = page2.waitForEvent("filechooser");
  await page2.getByRole("button", { name: "画板包 ▾" }).click();
  await page2.getByRole("menuitem", { name: "导入画板包…" }).click();
  await (await chooser).setFiles(file);
  await expect(page2.locator(".toast")).toContainText("导入 1 个任务");
  await expect(task(page2, "t")).toBeVisible();
  await task(page2, "t").locator(".task-actions button.primary").click();
  await expect(page2.locator(".toast")).toContainText("Lite 已停用，请切换到 Flash");
  expect(rig.stub.requests.filter((r) => r.path.startsWith("/v1/images/"))).toHaveLength(0);
  await other.close();
});
