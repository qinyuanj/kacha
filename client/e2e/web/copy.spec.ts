// 复制图片后回贴形成新的参考图节点（#115）：单选参考图按 Ctrl+C 把图片交给浏览器的复制链，
// 复制不改画板；随后回贴（合成的 paste 事件）落成一张新的参考图节点，原节点照旧。
//
// 为什么回贴用合成 paste 事件：页面跑在内网 HTTP 上不是安全上下文，navigator.clipboard 不存在，
// e2e 读不到系统剪贴板（与 kit.pasteImage 同一路数）。真实系统剪贴板的验收由 #116 在真机上做。
// 复制那一侧仍然是真的：Ctrl+C 走应用的复制链，页面把复制命令与原生 copy 事件记下来，
// 断言「复制确实发生过」，而不是只看回贴的结果。
import { expect } from "@playwright/test";
import { board, png, referenceNode, task } from "../common/boards";
import { importedReferencePath, sha256OfBase64 } from "../common/clipboard";
import { test } from "./rig";
import { openApp, pasteImage, savedBoard } from "./kit";

const REF = importedReferencePath("0".repeat(64));

test("复制图片后回贴：形成新的参考图节点，画板原节点不动", async ({ page, rig }) => {
  const image = png(256, 256, { rgb: [40, 120, 200] });
  // 记录复制链的证据：复制命令被调用过、原生 copy 事件发生过。
  await page.addInitScript(() => {
    const w = window as any;
    w.__kachaCopy = { commands: 0, events: 0, src: null as string | null };
    const original = document.execCommand?.bind(document);
    document.execCommand = ((command: string, ...rest: unknown[]) => {
      if (command === "copy") {
        w.__kachaCopy.commands += 1;
        // 交给浏览器的就是当前选区罩着的那张临时图片：记下它的地址。
        // 不能按 document.body 里的第一个 img 取——那是画布上的缩略图，不是复制对象。
        // 选区实际罩住的图片：selectNode 把 range 的容器设成父节点，所以要逐张问 intersectsNode，
        // 不能取 body 里的第一个 img（那是画布上的缩略图）。
        const range = document.getSelection()?.getRangeAt?.(0) ?? null;
        const covered = range ? [...document.querySelectorAll("img")].filter((img) => range.intersectsNode(img)) : [];
        w.__kachaCopy.src = covered[0]?.getAttribute("src") ?? null;
      }
      return original ? original(command, ...(rest as [])) : false;
    }) as typeof document.execCommand;
    document.addEventListener("copy", () => {
      w.__kachaCopy.events += 1;
    });
  });

  const errors = await openApp(page, rig, {
    title: "复制图片",
    boardText: board("复制图片", [referenceNode("r1", REF, [200, 100])], []),
    files: { [REF]: { b64: image } },
  });
  const refsOf = () => savedBoard(rig, "复制图片").nodes.filter((n: any) => n.type === "reference");

  // 单选参考图节点。
  await task(page, "r1").locator("img.thumb").click();
  await expect(task(page, "r1")).toHaveClass(/selected/);

  // Ctrl+C：走图片复制。复制动作确实发生了——复制命令被调用，原生 copy 事件也发生了。
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => (window as any).__kachaCopy.commands)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__kachaCopy.events)).toBeGreaterThan(0);
  // 交给浏览器的是这张参考图的地址（不是别的东西，也不是节点标记文本）。
  // 地址形如 /api/fs/file?path=<用户数据根内的相对路径>：根前缀由客户端剥掉。
  expect(await page.evaluate(() => (window as any).__kachaCopy.src)).toBe(`/api/fs/file?path=${encodeURIComponent(REF)}`);
  // 无论浏览器这条链成没成，复制都不该改画板。
  await expect.poll(() => refsOf().map((n: any) => n.id)).toEqual(["r1"]);
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(1);

  // 回贴：合成 paste 事件把这张图片送进画板，落成一张新的参考图节点。
  await pasteImage(page, { name: "原图.png", mimeType: "image/png", b64: image }, { x: 600, y: 400 });
  await expect(page.locator(".react-flow__node-reference")).toHaveCount(2);
  await expect.poll(() => refsOf().length).toBe(2);
  // 新节点是导入参考图（按内容寻址落盘），原节点照旧。
  expect(refsOf().map((n: any) => n.path).sort()).toEqual([importedReferencePath(sha256OfBase64(image)), REF].sort());
  expect(errors).toEqual([]);
});
