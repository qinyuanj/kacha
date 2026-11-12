// 内嵌图片 data URL 的粘贴（#114）：文本或 HTML 里内嵌的图片解成真实字节后落成参考图节点，
// 与文件、图片条目同一条链路；网络图片地址不被抓取，只给提示。
// 说明：e2e 只在集成分支上跑，本分支只写用例、不执行。
import { existsSync } from "node:fs";
import { expect } from "@playwright/test";
import { board, png } from "../common/boards";
import { importedReferencePath, sha256OfBase64 } from "../common/clipboard";
import { PASTE_NAME_PREFIX } from "../../src/core/pageInput";
import { PASTE_TEXT } from "../../src/ui/boardText";
import { GOOD_KEY, test } from "./rig";
import { openApp, pasteDataUrl, savedRef } from "./kit";

test("文本里内嵌的图片 data URL：解成真实字节落成参考图节点", async ({ page, rig }) => {
  const image = png(256, 256, { rgb: [12, 200, 90] });
  const errors = await openApp(page, rig, { title: "粘贴", boardText: board("粘贴", [], []) });

  await pasteDataUrl(page, `data:image/png;base64,${image}`, { x: 460, y: 340 }, "text");
  const node = page.locator(".react-flow__node-reference");
  await expect(node).toHaveCount(1);
  await expect(node.locator("img.thumb")).toBeVisible();

  // 字节确实落盘成用户数据根里的哈希文件（不是只建了个空节点）。
  const rel = importedReferencePath(sha256OfBase64(image));
  expect(existsSync(`${rig.userRoot(GOOD_KEY)}/${rel}`)).toBe(true);
  await expect.poll(() => savedRef(rig, "粘贴")?.path).toBe(rel);
  expect(savedRef(rig, "粘贴").display_name.startsWith(`${PASTE_NAME_PREFIX}-`)).toBe(true);
  expect(errors).toEqual([]);
});

test("HTML 里内嵌的图片 data URL：同样落成参考图节点", async ({ page, rig }) => {
  const image = png(128, 128, { rgb: [240, 120, 10] });
  const errors = await openApp(page, rig, { title: "粘贴HTML", boardText: board("粘贴HTML", [], []) });

  await pasteDataUrl(page, `data:image/png;base64,${image}`, { x: 380, y: 300 }, "html");
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);
  const rel = importedReferencePath(sha256OfBase64(image));
  await expect.poll(() => savedRef(rig, "粘贴HTML")?.path).toBe(rel);
  expect(errors).toEqual([]);
});

test("网络图片地址：不抓取、不导入，只给一条可操作的提示", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "粘贴远程", boardText: board("粘贴远程", [], []) });

  // 页面里所有网络请求都记下来：应用绝不能去抓那个地址。
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));

  await pasteDataUrl(page, "https://example.com/remote.png", { x: 400, y: 300 }, "html");
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText(PASTE_TEXT.remoteImage);
  expect(requests.filter((u) => u.includes("example.com"))).toEqual([]);
  expect(errors).toEqual([]);
});
