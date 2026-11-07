// 图层拆分：生成 → 预览 → 重开按任务目录真源还原 → 下载（迁移自旧假壳 specs/layers.spec.ts）。
// 桌面版「选目录导出图层」在 Web 版换成整包 zip 下载。
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { board, edge, png, referenceNode, taskNode } from "../common/boards";
import { unzip } from "../common/zip";
import { FLASH } from "../common/layers";
import { enterWithKey, GOOD_KEY, test } from "./rig";
import { boardRelPath, openApp, seed, task, taskRecords } from "./kit";

const bbox = { absolute: [100, 200, 400, 600], normalized: [100, 200, 400, 600] };
const base = png(1000, 1000);
const layer = png(72, 96, { alpha: true, rgb: [210, 80, 42] });

test("single image → optional prompt → bbox preview → 下载 zip → 重开按任务目录真源还原", async ({ page, rig }) => {
  const title = "官方契约合成图层";
  const text = board(title, [referenceNode("r", "导入参考图/synthetic.png"), taskNode("t", { model: FLASH, image_ports: 1 })], [edge("r", "t", "image:0")]);
  const errors = await openApp(page, rig, { title, boardText: text, files: { "导入参考图/synthetic.png": { b64: base } } });
  rig.stub.imageResponse = () => ({ json: { data: [{ z_index: 1, b64_json: layer, bounding_box: bbox, name: "合成主体", description: "官方契约合成资产，非网关实测" }, { z_index: 0, b64_json: base }] } });
  await task(page, "t").getByRole("button", { name: "展开", exact: true }).click();
  await task(page, "t").getByRole("checkbox", { name: "拆分图层" }).check();
  await expect(task(page, "t").getByRole("combobox", { name: "图层尺寸" })).toHaveValue("auto");
  await expect(task(page, "t").getByRole("combobox", { name: "宽高比", exact: true })).toHaveCount(0);
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  expect(rig.stub.requests).toHaveLength(1);
  expect(rig.stub.requests[0].body).toMatchObject({ layer_decomposition: true, size: "auto" });
  expect(rig.stub.requests[0].body).not.toHaveProperty("prompt");
  const dir = taskRecords(rig)[0].path.replace(/task\.json$/, "");
  const metadata = JSON.parse(readFileSync(`${dir}layers.json`, "utf8"));
  expect(metadata.layers[0]).toMatchObject({ bounding_box: bbox, name: "合成主体" });
  await expect.poll(() => JSON.parse(readFileSync(`${rig.userRoot(GOOD_KEY)}/${boardRelPath(title)}`, "utf8")).nodes.some((n: any) => n.type === "result")).toBe(true);
  // 画板里的冗余图层副本被改掉；任务目录仍是真源，重开后图层还在。
  const boardFile = `${rig.userRoot(GOOD_KEY)}/${boardRelPath(title)}`;
  const raw = JSON.parse(readFileSync(boardFile, "utf8"));
  raw.nodes.find((n: any) => n.type === "result").record.layers = [];
  writeFileSync(boardFile, JSON.stringify(raw));
  await page.locator(".tab", { hasText: title }).locator(".tab-close").click();
  await expect(page.locator(".tab", { hasText: title })).toHaveCount(0);
  await page.getByRole("button", { name: "画板列表", exact: true }).click();
  await page.getByRole("dialog", { name: "画板列表" }).getByRole("button", { name: title, exact: true }).click();
  const result = page.locator(".react-flow__node-result");
  await expect(result).toHaveCount(1);
  await result.locator("img").first().dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".layer-list")).toContainText("合成主体");
  await dialog.locator(".layer-list input[type=checkbox]").check();
  const overlay = dialog.locator(".preview-layer");
  await expect(overlay).toHaveCSS("position", "absolute");
  const dimensions = await overlay.evaluate((el) => {
    const image = el.getBoundingClientRect(), canvas = el.parentElement!.getBoundingClientRect();
    return { left: (image.left - canvas.left) / canvas.width, top: (image.top - canvas.top) / canvas.height, width: image.width / canvas.width, height: image.height / canvas.height };
  });
  expect(dimensions.left).toBeCloseTo(0.1, 2);
  expect(dimensions.top).toBeCloseTo(0.2, 2);
  expect(dimensions.width).toBeCloseTo(0.3, 2);
  expect(dimensions.height).toBeCloseTo(0.4, 2);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "保存全部图层 + layers.json", exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/\.zip$/);
  const entries = unzip(readFileSync((await saved.path())!));
  expect(entries.map((e) => e.name)).toEqual(["layers.json", "layers/01.png", "result.png"]);
  expect(JSON.parse(entries[0].bytes.toString("utf8")).layers[0]).toMatchObject({ bounding_box: bbox, name: "合成主体", description: "官方契约合成资产，非网关实测" });
  expect(entries[1].bytes).toEqual(Buffer.from(layer, "base64"));
  expect(errors).toEqual([]);
});

// 图层元数据损坏必须按真实原因提示，不能误报「找不到画板文件」或静默跳过。
const TASK_ID = "20261010T000000Z-abcdef01";
const TASK_DIR = `2026-10-10/${TASK_ID}`;
const CORRUPT_TITLE = "损坏图层画板";
const corruptBoard = () =>
  board(
    CORRUPT_TITLE,
    [
      {
        id: "res",
        type: "result",
        pos: [0, 0],
        size: [200, 200],
        task_id: TASK_ID,
        file: "result.png",
        path: `${TASK_DIR}/result.png`,
        layer_count: 1,
        record: { model: FLASH, prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "", layers: [{ file: "layers/01.png", z_index: 1, bounding_box: bbox }] },
      },
    ],
    [],
  );
const corruptFiles = { [`${TASK_DIR}/result.png`]: { b64: base }, [`${TASK_DIR}/layers.json`]: { text: "{损坏" } };

test("layers.json 损坏：从画板列表打开报真实原因，不误报找不到画板文件", async ({ page, rig }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  seed(rig, { title: CORRUPT_TITLE, boardText: corruptBoard(), files: corruptFiles });
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  // 启动恢复即报损坏（打开的标签页被丢弃）；再从画板列表打开一次，提示一致。
  await expect(page.locator(".toast")).toContainText("图层元数据损坏");
  await page.getByRole("button", { name: "画板列表", exact: true }).click();
  await page.getByRole("dialog", { name: "画板列表" }).getByRole("button", { name: CORRUPT_TITLE, exact: true }).click();
  await expect(page.locator(".toast")).toContainText("图层元数据损坏");
  await expect(page.locator(".toast")).not.toContainText("找不到画板文件");
  await expect(page.locator(".tab", { hasText: CORRUPT_TITLE })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("画板文件确实不存在时仍报找不到画板文件", async ({ page, rig }) => {
  // 界面状态里记着一张已被删掉的画板：启动恢复时报「找不到画板文件」，不静默跳过。
  seed(rig, { title: "空", boardText: board("空", [], []) });
  rmSync(`${rig.userRoot(GOOD_KEY)}/${boardRelPath("空")}`);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await enterWithKey(page, rig.baseURL, GOOD_KEY);
  await expect(page.locator(".toast")).toContainText("找不到画板文件");
  await expect(page.locator(".tab")).toHaveCount(1);
  expect(errors).toEqual([]);
});
