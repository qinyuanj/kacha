// 在画板上按 Ctrl+V 把系统剪贴板里的截图粘成参考图节点（#96）：落进 导入参考图/、落点跟鼠标、
// 只算一个撤销步。剪贴板读不到内容（浏览器限制）只能用合成的 paste 事件覆盖，见 kit 的 pasteImage。
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { board, png } from "../common/boards";
import { PASTE_NAME_PREFIX } from "../../src/core/pageInput";
import { GOOD_KEY, test, type Rig } from "./rig";
import { boardRelPath, openApp, pasteImage, readJson } from "./kit";

const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
const savedBoard = (rig: Rig) => readJson(`${rig.userRoot(GOOD_KEY)}/${boardRelPath("粘贴")}`);
const savedRef = (rig: Rig) => savedBoard(rig).nodes.find((n: any) => n.type === "reference");

test("粘贴剪贴板里的截图：落成参考图节点，落点跟鼠标，撤销一步回退", async ({ page, rig }) => {
  const image = png(1024, 1024, { rgb: [30, 90, 200] });
  const errors = await openApp(page, rig, { title: "粘贴", boardText: board("粘贴", [], []) });

  await pasteImage(page, { name: "image.png", mimeType: "image/png", b64: image }, { x: 500, y: 400 });
  const node = page.locator(".react-flow__node-reference");
  await expect(node).toHaveCount(1);
  await expect(node.locator("img.thumb")).toBeVisible();
  // 粘出来的节点处于选中态。React Flow 给选中的节点加 selected class。
  await expect(node).toHaveClass(/selected/);

  // 内容落盘成用户数据根里的哈希文件，画板引用它；显示名走粘贴产物的统一命名。
  const rel = `导入参考图/${sha(image)}.png`;
  expect(existsSync(`${rig.userRoot(GOOD_KEY)}/${rel}`)).toBe(true);
  await expect.poll(() => savedRef(rig)?.path).toBe(rel);
  const ref = savedRef(rig);
  expect(ref.display_name.startsWith(`${PASTE_NAME_PREFIX}-`), `粘贴产物的显示名应为 ${PASTE_NAME_PREFIX}-<年月日>-<时分>.png，实际是 ${ref.display_name}`).toBe(true);

  // 落点跟着鼠标：粘贴时指针在页面坐标 (500, 400)，节点左上角就落在那儿（画布视口为 1:1、无平移）。
  const box = (await node.boundingBox())!;
  expect(Math.abs(box.x - 500) <= 8 && Math.abs(box.y - 400) <= 8, `节点应落在 (500, 400) 附近，实际左上角 (${box.x}, ${box.y})`).toBe(true);

  // 一次粘贴（含上传）只算一个撤销步。
  await page.keyboard.press("Control+z");
  await expect(node).toHaveCount(0);
  expect(errors).toEqual([]);
});
