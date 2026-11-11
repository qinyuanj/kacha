// 本机图片上传为参考图（文件选择器 / HTML5 拖入）、缺图重新定位、单张与整板结果下载（#28 新增场景）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { IMPORT_TEXT } from "../../src/ui/boardText";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { unzip } from "../common/zip";
import { DIR, FLASH, flashResult, taskFiles, TASK_ID } from "../common/layers";
import { GOOD_KEY, test, type Rig } from "./rig";
import { boardRelPath, dropFile, openApp, task } from "./kit";

const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const dropPng = (b64: string) => ({ name: "拖入.png", mimeType: "image/png", b64 });
const savedBoard = (rig: Rig, title: string) => JSON.parse(readFileSync(`${rig.userRoot(GOOD_KEY)}/${boardRelPath(title)}`, "utf8"));

test("浏览器选择本机图片：上传进 导入参考图/，画板引用它", async ({ page, rig }) => {
  const image = png(1024, 1024, { rgb: [180, 20, 30] });
  const errors = await openApp(page, rig, { title: "上传", boardText: board("上传", [], []) });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("toolbar", { name: "画板工具栏" }).getByRole("button", { name: "＋ 参考图…" }).click();
  await (await chooser).setFiles({ name: "本机猫.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);
  await expect(page.locator(".react-flow__node-reference img.thumb")).toBeVisible();
  const rel = `导入参考图/${sha(image)}.png`;
  expect(existsSync(`${rig.userRoot(GOOD_KEY)}/${rel}`)).toBe(true);
  await expect.poll(() => savedBoard(rig, "上传").nodes.find((n: any) => n.type === "reference")?.path).toBe(rel);
  // 显示名保留本机文件名，而路径是用户数据根内的哈希文件。
  expect(savedBoard(rig, "上传").nodes.find((n: any) => n.type === "reference").display_name).toBe("本机猫.png");
  expect(errors).toEqual([]);
});

test("拖进页面：图片上传为参考图；非图片给出提示", async ({ page, rig }) => {
  const image = png(64, 64);
  const errors = await openApp(page, rig, { title: "拖入", boardText: board("拖入", [], []) });
  await dropFile(page, dropPng(image), { x: 300, y: 300 });
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);
  expect(readdirSync(`${rig.userRoot(GOOD_KEY)}/导入参考图`)).toEqual([`${sha(image)}.png`]);
  await dropFile(page, { name: "说明.txt", mimeType: "text/plain", b64: Buffer.from("{}").toString("base64") }, { x: 300, y: 300 });
  await expect(page.locator(".toast")).toContainText(IMPORT_TEXT.imageOnly);
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("拖到任务卡片上：上传后自动接到空图片端口，可提交图片编辑生成", async ({ page, rig }) => {
  const image = png(1024, 1024, { rgb: [180, 20, 30] });
  const errors = await openApp(page, rig, { title: "拖入编辑", boardText: board("拖入编辑", [promptNode("p", "把图1 改成蓝色"), taskNode("t", { model: FLASH, image_ports: 1 })], [edge("p", "t", "positive")]) });
  const box = (await task(page, "t").boundingBox())!;
  await dropFile(page, dropPng(image), { x: box.x + 20, y: box.y + 20 });
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);
  await expect.poll(() => savedBoard(rig, "拖入编辑").edges.some((e: any) => e.from[0] !== "p" && e.to[0] === "t")).toBe(true);
  await task(page, "t").locator(".task-actions button.primary").click();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(1);
  expect(rig.stub.requests[0].body.image).toEqual([`data:image/png;base64,${image}`]);
  expect(errors).toEqual([]);
});

test.describe("重新定位：缺图节点保留占位，可在用户数据根内找回或改选本机文件", () => {
  const image = png(48, 48, { rgb: [200, 60, 60] });
  const title = "重定位";
  const scn = (files: Record<string, { b64: string }>) => ({
    title,
    boardText: board(title, [{ ...referenceNode("r1", "导入参考图/原图.png"), sha256: sha(image) }], []),
    files,
  });
  const savedRefPath = (rig: Rig) => savedBoard(rig, title).nodes.find((n: { id: string }) => n.id === "r1")?.path;

  test("自动查找：按 sha256 在用户数据根内找回并恢复显示", async ({ page, rig }) => {
    await openApp(page, rig, scn({ "2026-09-10/20260910T000000Z-bbbb0001/reference-1.png": { b64: image } }));
    const node = task(page, "r1");
    await expect(node).toContainText("图片缺失");
    await node.getByRole("button", { name: "重新定位" }).click();
    await expect(node.locator("img.thumb")).toBeVisible();
    await expect(node).not.toContainText("图片缺失");
    await expect.poll(() => savedRefPath(rig)).toBe("2026-09-10/20260910T000000Z-bbbb0001/reference-1.png");
  });

  test("自动查找找不到：提示改为手动选择", async ({ page, rig }) => {
    await openApp(page, rig, scn({}));
    await task(page, "r1").getByRole("button", { name: "重新定位" }).click();
    await expect(page.locator(".toast")).toContainText("没有找到 原图.png，可改为手动选择文件");
  });

  test("手动选择：本机文件上传后写回节点", async ({ page, rig }) => {
    await openApp(page, rig, scn({}));
    const chooser = page.waitForEvent("filechooser");
    await task(page, "r1").getByRole("button", { name: "选文件…" }).click();
    await (await chooser).setFiles({ name: "手选.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await expect(task(page, "r1").locator("img.thumb")).toBeVisible();
    await expect.poll(() => savedRefPath(rig)).toBe(`导入参考图/${sha(image)}.png`);
  });
});

test("结果节点另存为：无图层下载原图，有图层下载 zip；整板结果下载为一个 zip", async ({ page, rig }) => {
  const otherDir = "2026-11-04/20261104T020000Z-0000000b";
  const other = png(64, 64, { rgb: [1, 2, 3] });
  const text = board("下载", [flashResult("res"), { ...flashResult("res2", [900, 0]), task_id: "20261104T020000Z-0000000b", path: `${otherDir}/result.png`, layer_count: 0, record: { ...flashResult("res").record, layers: undefined } }], []);
  const errors = await openApp(page, rig, {
    title: "下载",
    boardText: text,
    files: { ...taskFiles(), [`${otherDir}/result.png`]: { b64: other }, [`${otherDir}/task.json`]: { text: "{}" } },
  });
  // 单张（无图层）：直接下载 PNG 附件。
  await task(page, "res2").click({ button: "right", position: { x: 4, y: 4 } });
  const single = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "另存为…" }).click();
  const one = await single;
  expect(one.suggestedFilename()).toBe("result.png");
  expect(readFileSync((await one.path())!)).toEqual(Buffer.from(other, "base64"));
  // 单张（带图层）：zip 含底图与图层。
  await task(page, "res").click({ button: "right", position: { x: 4, y: 4 } });
  const zipped = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "另存为…" }).click();
  const pack = await zipped;
  expect(pack.suggestedFilename()).toBe(`${TASK_ID}.zip`);
  expect(unzip(readFileSync((await pack.path())!)).map((e) => e.name)).toEqual(["layers.json", "layers/01.png", "layers/02.png", "result.png"]);
  // 整板：每个结果一次，带图层，按任务目录归置。
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  const all = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载整板结果（zip）" }).click();
  const boardZip = await all;
  expect(boardZip.suggestedFilename()).toBe("下载-结果.zip");
  const entries = unzip(readFileSync((await boardZip.path())!));
  expect(entries.map((e) => e.name)).toEqual([`${DIR}/layers.json`, `${DIR}/layers/01.png`, `${DIR}/layers/02.png`, `${DIR}/result.png`, `${otherDir}/result.png`]);
  expect(entries.find((e) => e.name === `${otherDir}/result.png`)!.bytes).toEqual(Buffer.from(other, "base64"));
  expect(errors).toEqual([]);
});

test("整板 zip：缺失的结果列进包内说明，其余照常打包", async ({ page, rig }) => {
  const gone = "2026-11-04/20261104T030000Z-0000000c";
  const text = board("部分缺失", [flashResult("res"), { ...flashResult("res2", [900, 0]), path: `${gone}/result.png`, task_id: "20261104T030000Z-0000000c" }], []);
  await openApp(page, rig, { title: "部分缺失", boardText: text, files: taskFiles() });
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  const all = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载整板结果（zip）" }).click();
  const entries = unzip(readFileSync((await (await all).path())!));
  expect(entries.map((e) => e.name)).toContain("缺失文件.txt");
  expect(entries.find((e) => e.name === "缺失文件.txt")!.bytes.toString("utf8")).toContain(`${gone}/result.png`);
  expect(entries.map((e) => e.name)).toContain(`${DIR}/result.png`);
});
