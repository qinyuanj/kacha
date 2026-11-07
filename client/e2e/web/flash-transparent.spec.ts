// 透明背景编辑生成（迁移自旧假壳 specs/flash-transparent.spec.ts）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { bodies, test, type Rig } from "./rig";
import { openApp, task, taskRecords } from "./kit";

const FLASH = "doubao-seedream-5-0-flash-260915";
const REF = "导入参考图/alpha.png";

async function setup(page: Page, rig: Rig, alpha = true, region = false) {
  const text = board("透明", [promptNode("p", "把图1 改成红色"), referenceNode("r", REF), taskNode("t", { model: FLASH, image_ports: 1 })], [edge("p", "t", "positive"), edge("r", "t", "image:0", region ? { region: { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" } } : {})]);
  const errors = await openApp(page, rig, { title: "透明", boardText: text, files: { [REF]: { b64: png(32, 32, { alpha }) } } });
  await task(page, "t").getByRole("button", { name: "展开" }).click();
  return errors;
}

test("透明开关到生成、保存和历史重新生成，PNG/JPEG 控件一致", async ({ page, rig }) => {
  const errors = await setup(page, rig);
  rig.stub.imageResponse = () => ({ json: { data: [{ b64_json: png(32, 32, { alpha: true }) }] } });
  const toggle = task(page, "t").getByRole("checkbox", { name: /透明背景/ });
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await task(page, "t").getByRole("combobox", { name: "输出格式" }).selectOption("jpeg");
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".toast")).toContainText("透明背景输出必须为 PNG");
  expect(bodies(rig)).toHaveLength(0);
  await task(page, "t").getByRole("combobox", { name: "输出格式" }).selectOption("png");
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  expect(bodies(rig)[0]).toMatchObject({ background: "transparent", output_format: "png", model: FLASH });
  expect(bodies(rig)[0].image).toHaveLength(1);
  expect(taskRecords(rig)[0].json).toMatchObject({ transparent_background: true, output_options: { output_format: "png" } });
  await toggle.uncheck();
  await task(page, "t").getByRole("combobox", { name: "输出格式" }).selectOption("jpeg");
  await task(page, "t").locator(".node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "重新生成", exact: true }).click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(2);
  expect(bodies(rig)[1]).toMatchObject({ background: "transparent", output_format: "png", image: bodies(rig)[0].image });
  expect(errors).toEqual([]);
});

for (const mode of ["opaque", "overlay"] as const)
  test(`透明开关拒绝 ${mode} 输入`, async ({ page, rig }) => {
    await setup(page, rig, mode !== "opaque", mode === "overlay");
    const toggle = task(page, "t").getByRole("checkbox", { name: /透明背景/ });
    await expect(toggle).toBeDisabled();
    await expect(task(page, "t")).toContainText(mode === "opaque" ? "该图不带透明通道" : "需要恰好一张实际参考图");
  });

// url 形式的图层与透明结果也走 #27 的中转：暂存 → 读回校验 → 按序提交。
test("url 形式的透明结果与图层经服务端中转，校验后提交为成品", async ({ page, rig }) => {
  // 图层拆分要求参考图至少 262144 像素，参考图用 1024×1024。
  const text = board("透明图层", [promptNode("p", "把图1 改成红色"), referenceNode("r", REF), taskNode("t", { model: FLASH, image_ports: 1 })], [edge("p", "t", "positive"), edge("r", "t", "image:0")]);
  const errors = await openApp(page, rig, { title: "透明图层", boardText: text, files: { [REF]: { b64: png(1024, 1024, { alpha: true }) } } });
  await task(page, "t").getByRole("button", { name: "展开" }).click();
  const base = png(64, 64, { alpha: true });
  const layer = png(64, 64, { alpha: true, rgb: [255, 0, 0] });
  rig.stub.objects.set("/objects/base.png", Buffer.from(base, "base64"));
  rig.stub.objects.set("/objects/layer.png", Buffer.from(layer, "base64"));
  rig.stub.imageResponse = () => ({
    json: {
      data: [
        { z_index: 1, url: `${rig.stub.url}/objects/layer.png`, bounding_box: { absolute: [0, 0, 64, 64], normalized: [0, 0, 1000, 1000] }, name: "主体" },
        { z_index: 0, url: `${rig.stub.url}/objects/base.png` },
      ],
    },
  });
  await task(page, "t").getByRole("checkbox", { name: /透明背景/ }).check();
  await task(page, "t").getByRole("checkbox", { name: "拆分图层" }).check();
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  const dir = path.dirname(taskRecords(rig)[0].path);
  expect(readFileSync(path.join(dir, "result.png"))).toEqual(Buffer.from(base, "base64"));
  expect(readFileSync(path.join(dir, "layers/01.png"))).toEqual(Buffer.from(layer, "base64"));
  expect(JSON.parse(readFileSync(path.join(dir, "layers.json"), "utf8")).layers[0]).toMatchObject({ file: "layers/01.png", name: "主体" });
  expect(existsSync(path.join(dir, ".staging")), "提交后不留暂存区").toBe(false);
  expect(readdirSync(dir).sort()).toEqual(["layers", "layers.json", "reference-1.png", "result.png", "task.json"]);
  expect(errors).toEqual([]);
});
