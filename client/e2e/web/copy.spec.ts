// 复制图片后回贴形成新的参考图节点（#115）：单选参考图按 Ctrl+C 把图片交给浏览器复制链，
// 复制不改画板；回贴（合成的 paste 事件）落成一张新的参考图节点，原节点照旧。
//
// 为什么用合成 paste 事件：页面跑在内网 HTTP 上不是安全上下文，navigator.clipboard 不存在，
// e2e 读不到系统剪贴板（与 kit.pasteImage 同一路数）。
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { board, png, referenceNode } from "../common/boards";
import { GOOD_KEY, test, type Rig } from "./rig";
import { boardRelPath, openApp, pasteImage, readJson, task } from "./kit";

const REF = "导入参考图/原图.png";
const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const savedBoard = (rig: Rig) => readJson(`${rig.userRoot(GOOD_KEY)}/${boardRelPath("复制图片")}`);
const refsOf = (rig: Rig) => savedBoard(rig).nodes.filter((n: any) => n.type === "reference");

test("复制图片后回贴：形成新的参考图节点，画板原节点不动", async ({ page, rig }) => {
  const image = png(256, 256, { rgb: [40, 120, 200] });
  const errors = await openApp(page, rig, {
    title: "复制图片",
    boardText: board("复制图片", [referenceNode("r1", REF, [200, 100])], []),
    files: { [REF]: { b64: image } },
  });

  // 观察浏览器有没有真的派发原生 copy 事件：#115 要求命令返回成功之外还要有这份证据。
  await page.evaluate(() => {
    (window as unknown as { __copyEvents: number }).__copyEvents = 0;
    document.addEventListener("copy", () => {
      (window as unknown as { __copyEvents: number }).__copyEvents += 1;
    });
  });

  // 单选参考图节点。
  await task(page, "r1").locator("img.thumb").click();
  await expect(task(page, "r1")).toHaveClass(/selected/);

  // Ctrl+C：复制图片，不改画板、不新增节点、不构成撤销步。
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copyEvents: number }).__copyEvents)).toBeGreaterThan(0);
  // 成功不弹提示；失败会弹「复制图片失败…」，两种情况都不该在这里出现失败提示。
  expect((await page.locator(".toast").allTextContents()).join(" ")).not.toContain("复制图片失败");
  expect(refsOf(rig).map((n: any) => n.id)).toEqual(["r1"]);

  // 回贴：合成 paste 事件把这张图片送进画板，落成一张新的参考图节点。
  await pasteImage(page, { name: "原图.png", mimeType: "image/png", b64: image }, { x: 600, y: 400 });
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(2);
  await expect.poll(() => refsOf(rig).length).toBe(2);
  // 新节点是导入参考图（按内容寻址落盘），原节点照旧。
  expect(refsOf(rig).map((n: any) => n.path).sort()).toEqual([`导入参考图/${sha(image)}.png`, REF].sort());
  expect(errors).toEqual([]);
});