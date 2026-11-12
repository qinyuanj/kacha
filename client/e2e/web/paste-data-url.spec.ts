// 内嵌图片 data URL 的粘贴（#114）：文本或 HTML 里内嵌的图片解成真实字节后落成参考图节点，
// 与文件、图片条目同一条链路；远程图片地址不被抓取，只给提示。
// 说明：e2e 只在集成分支上跑，本分支只写用例、不执行。
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { board, png } from "../common/boards";
import { PASTE_NAME_PREFIX } from "../../src/core/pageInput";
import { GOOD_KEY, test, type Rig } from "./rig";
import { boardRelPath, openApp, readJson } from "./kit";

const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const savedBoard = (rig: Rig, title = "粘贴") => readJson(`${rig.userRoot(GOOD_KEY)}/${boardRelPath(title)}`);
const savedRef = (rig: Rig, title = "粘贴") => savedBoard(rig, title).nodes.find((n: any) => n.type === "reference");

/** 在页面里合成一次带内嵌 data URL 的 paste 事件：剪贴板里没有文件列表，只有文本 / HTML。 */
async function pasteDataUrl(page: import("@playwright/test").Page, dataUrl: string, at: { x: number; y: number }, as: "text" | "html"): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.evaluate(
    ({ dataUrl, as }) => {
      const clipboard = {
        files: [],
        items: [],
        getData: (type: string) => {
          if (as === "text" && type === "text/plain") return dataUrl;
          if (as === "html" && type === "text/html") return `<img src="${dataUrl}">`;
          return "";
        },
      };
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboard });
      document.body.dispatchEvent(event);
    },
    { dataUrl, as },
  );
}

test("文本里内嵌的图片 data URL：解成真实字节落成参考图节点", async ({ page, rig }) => {
  const image = png(256, 256, { rgb: [12, 200, 90] });
  const errors = await openApp(page, rig, { title: "粘贴", boardText: board("粘贴", [], []) });

  await pasteDataUrl(page, `data:image/png;base64,${image}`, { x: 460, y: 340 }, "text");
  const node = page.locator(".react-flow__node-reference");
  await expect(node).toHaveCount(1);
  await expect(node.locator("img.thumb")).toBeVisible();

  // 字节确实落盘成用户数据根里的哈希文件（不是只建了个空节点）。
  const rel = `导入参考图/${sha(image)}.png`;
  expect(existsSync(`${rig.userRoot(GOOD_KEY)}/${rel}`)).toBe(true);
  await expect.poll(() => savedRef(rig)?.path).toBe(rel);
  expect(savedRef(rig).display_name.startsWith(`${PASTE_NAME_PREFIX}-`)).toBe(true);
  expect(errors).toEqual([]);
});

test("HTML 里内嵌的图片 data URL：同样落成参考图节点", async ({ page, rig }) => {
  const image = png(128, 128, { rgb: [240, 120, 10] });
  const errors = await openApp(page, rig, { title: "粘贴HTML", boardText: board("粘贴HTML", [], []) });

  await pasteDataUrl(page, `data:image/png;base64,${image}`, { x: 380, y: 300 }, "html");
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);
  const rel = `导入参考图/${sha(image)}.png`;
  await expect.poll(() => savedRef(rig, "粘贴HTML")?.path).toBe(rel);
  expect(errors).toEqual([]);
});

test("远程图片地址：不抓取、不导入，只给一条可操作的提示", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "粘贴远程", boardText: board("粘贴远程", [], []) });

  // 页面里所有网络请求都记下来：应用绝不能去抓那个地址。
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));

  await pasteDataUrl(page, "https://example.com/remote.png", { x: 400, y: 300 }, "html");
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("网络图片地址");
  expect(requests.filter((u) => u.includes("example.com"))).toEqual([]);
  expect(errors).toEqual([]);
});
