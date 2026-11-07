// 图片编辑：参考图 + 区域指示。
// 参考图向用户数据根预置；结果默认 url 形式，经服务端中转落任务目录。
import { expect, type Page } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { FLASH } from "../common/layers";
import { bodies, test } from "./rig";
import { openApp, task, taskRecords } from "./kit";

const REGION = { rects: [[0, 0, 1, 1]], render: "highlight_overlay" };
const A = "导入参考图/a.png";
const B = "导入参考图/b.png";
const files = { [A]: { b64: png(1024, 1024, { rgb: [180, 20, 30] }) }, [B]: { b64: png(1024, 1024, { rgb: [20, 30, 180] }) } };

async function runTask(page: Page) {
  await task(page, "t").locator(".task-actions button.primary").click();
  const confirm = page.getByRole("dialog", { name: "确认运行" });
  if (await confirm.count()) await confirm.getByRole("button", { name: "确认运行", exact: true }).click();
}

for (const prompt of ["把图2 的区域2复制到图1 的区域1，其余保持不变", "Copy region 2 of Image 2 to region 1 of Image 1, keep the rest unchanged"]) {
  test(`Flash UI选择坐标表达，跨图发送文本/端口/记录/载荷一致：${prompt}`, async ({ page, rig }) => {
    const text = board("区域", [promptNode("p", prompt), referenceNode("a", A), referenceNode("b", B), taskNode("t", { model: FLASH, image_ports: 2 })], [edge("p", "t", "positive"), edge("a", "t", "image:0", { region: REGION }), edge("b", "t", "image:1", { region: REGION })]);
    const errors = await openApp(page, rig, { title: "区域", boardText: text, files });
    await task(page, "t").getByRole("button", { name: "展开" }).click();
    await expect(task(page, "t").locator(".port-overlay")).toHaveCount(2);
    for (const [i, mode] of ["bbox", "point"].entries()) {
      await task(page, "t").locator("button.port-region").nth(i).click();
      await page.getByRole("combobox", { name: "区域表达" }).selectOption(mode);
      await page.getByRole("button", { name: "保存区域", exact: true }).click();
    }
    await expect(task(page, "t").locator(".port-overlay")).toHaveCount(0);
    await task(page, "t").locator(".node-title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "查看发送文本" }).click();
    const shown = await page.getByRole("dialog", { name: "查看发送文本" }).locator("pre.send-text").first().textContent();
    expect(shown).toContain("图1 <bbox>0 0 999 999</bbox>");
    expect(shown).toContain("图2 <point>500 500</point>");
    expect(shown).not.toContain("Image ");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await runTask(page);
    await expect.poll(() => bodies(rig).length).toBe(1);
    await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
    const record = taskRecords(rig)[0].json;
    expect(bodies(rig)[0].prompt).toBe(shown);
    expect(record.send_text).toBe(shown);
    expect(record.prompt).toBe(prompt);
    expect(record.references.map((r: any) => [r.region.render, r.region.coordinate_kind, r.region.source_port])).toEqual([["bbox_tag", "bbox", 1], ["bbox_tag", "point", 2]]);
    expect(bodies(rig)[0].image).toHaveLength(2);
    expect(record.references).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}

test("Flash 两张图各带叠加区域，发送四图按原图/叠加图顺序且英文引用换算", async ({ page, rig }) => {
  const prompt = "Copy region 2 of Image 2 into region 1 of Image 1";
  const text = board("叠加", [promptNode("p", prompt), referenceNode("a", A), referenceNode("b", B), taskNode("t", { model: FLASH, image_ports: 2 })], [edge("p", "t", "positive"), edge("a", "t", "image:0", { region: REGION }), edge("b", "t", "image:1", { region: REGION })]);
  await openApp(page, rig, { title: "叠加", boardText: text, files });
  await runTask(page);
  await expect.poll(() => bodies(rig).length).toBe(1);
  const body = bodies(rig)[0];
  const images = body.image ?? [];
  expect(images).toHaveLength(4);
  expect(images[0]).toBe(`data:image/png;base64,${files[A].b64}`);
  expect(images[2]).toBe(`data:image/png;base64,${files[B].b64}`);
  expect(body.prompt).toContain("图2 is an annotated copy of 图1");
  expect(body.prompt).toContain("图4 is an annotated copy of 图3");
  expect(body.prompt).toContain("the yellow region of 图3");
});

test("Flash 展开后11张参考图明确拒绝，保留全部端口", async ({ page, rig }) => {
  const refs = Array.from({ length: 9 }, (_, i) => referenceNode(`r${i}`, A));
  const text = board("超限", [promptNode("p", "图1保持不变"), ...refs, taskNode("t", { model: FLASH, image_ports: 9 })], [edge("p", "t", "positive"), ...refs.map((r, i) => edge(r.id, "t", `image:${i}`, { region: i < 2 ? REGION : null }))]);
  await openApp(page, rig, { title: "超限", boardText: text, files });
  await task(page, "t").getByRole("button", { name: "展开" }).click();
  await expect(task(page, "t").locator(".port-overlay")).toHaveCount(2);
  await expect(task(page, "t")).toContainText("参考图 11 张超出模型上限 10 张");
  await runTask(page);
  await expect(page.locator(".toast")).toContainText("参考图 11 张超出模型上限 10 张");
});
