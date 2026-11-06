// 节点缩略图（#64）：节点走缩略图接口并延迟加载，放大预览走原图，缺图占位不变。
import type { Page, Request } from "@playwright/test";
import { expect } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { test } from "./rig";
import { openApp, task } from "./kit";

const TASK_ID = "20260916T000000Z-aaaa0001";
const RESULT = `2026-09-16/${TASK_ID}/result.png`;
const REF = `2026-09-16/${TASK_ID}/reference-1.png`;
const thumbUrl = (rel: string) => `/api/fs/thumb?path=${encodeURIComponent(rel)}`;
const fileUrl = (rel: string) => `/api/fs/file?path=${encodeURIComponent(rel)}`;

const resultNode = (id: string, path: string, pos: [number, number] = [0, 0]) => ({
  id, type: "result", pos, size: [240, 240], task_id: TASK_ID, file: "result.png", path, layer_count: 0,
  record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T00:00:00Z" },
});

/** 记下页面发出的全部图片请求（`<img>`，不含 fetch）。 */
function imageRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r: Request) => {
    if (r.resourceType() === "image") urls.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });
  return urls;
}

test("大画板节点请求缩略图、不下载原图；打开预览时才请求原图", async ({ page, rig }) => {
  const images = imageRequests(page);
  const errors = await openApp(page, rig, { title: "大画板", boardText: board("大画板", [resultNode("res", RESULT)], []), files: { [RESULT]: { b64: png(2048, 2048) } } });

  const thumb = task(page, "res").locator("img.thumb");
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute("src", thumbUrl(RESULT));
  await expect(thumb).toHaveAttribute("loading", "lazy");
  await expect(thumb).toHaveAttribute("decoding", "async");
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  expect(images).toEqual([thumbUrl(RESULT)]);

  await thumb.dblclick();
  await expect(page.getByRole("dialog").locator("img").first()).toHaveAttribute("src", fileUrl(RESULT));
  await expect.poll(() => images).toContain(fileUrl(RESULT));
  expect(errors).toEqual([]);
});

test("端口缩略图与提示词参考图缩略图走缩略图接口并延迟加载", async ({ page, rig }) => {
  const text = board(
    "参考图",
    [promptNode("p1", "把图1变成水彩"), referenceNode("r1", REF), taskNode("t1", { image_ports: 1 }, [450, 0])],
    [edge("p1", "t1", "positive"), edge("r1", "t1", "image:0")],
  );
  const errors = await openApp(page, rig, { title: "参考图", boardText: text, files: { [REF]: { b64: png(1024, 1024) } } });

  for (const img of [task(page, "t1").locator(".port-thumb img"), task(page, "p1").locator(".reference-guide-thumb img")]) {
    await expect(img).toHaveAttribute("src", thumbUrl(REF));
    await expect(img).toHaveAttribute("loading", "lazy");
    await expect(img).toHaveAttribute("decoding", "async");
  }
  expect(errors).toEqual([]);
});

test("缺图节点仍显示「图片缺失」占位", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "缺图", boardText: board("缺图", [resultNode("gone", RESULT)], []) });
  await expect(task(page, "gone")).toContainText("图片缺失");
  await expect(task(page, "gone").locator("img.thumb")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("打开后原图被删、缩略图接口回 404：节点退回「图片缺失」占位", async ({ page, rig }) => {
  await page.route("**/api/fs/thumb?*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found", message: "文件不存在" }) }));
  await openApp(page, rig, { title: "中途缺图", boardText: board("中途缺图", [resultNode("res", RESULT)], []), files: { [RESULT]: { b64: png(1024, 1024) } } });
  await expect(task(page, "res")).toContainText("图片缺失");
  await expect(task(page, "res").locator("img.thumb")).toHaveCount(0);
});
