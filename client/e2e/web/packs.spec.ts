// 画板包（#24）新接缝：导出 = 浏览器下载流；导入 = 浏览器选文件流式上传 → 判定 → 合并 → 打开画板。
// 旧假壳的 pack.spec.ts 不在这里复用：它注入的是虚拟条目与导出规格 JSON，不是真 zip。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { board, edge, png, promptNode, referenceNode, taskNode } from "../common/boards";
import { zipBytes, zipNames, zipText } from "../common/zip";
import { expect, GOOD_KEY, OTHER_KEY, test, type Rig } from "./rig";
import { openApp, readJson, readText, taskRecords } from "./kit";

const TASK_ID = "20260916T010000Z-0000000a";
const DIR = `2026-09-16/${TASK_ID}`;
const V032 = fileURLToPath(new URL("../../fixtures/packs/v0.3.2-flash-layers.ugcpack", import.meta.url));
const REF_ENTRY = "导入参考图/5e4b079355f5f06363744c0778c5174040645713e06e6877eae22f573d46e6b0.png";

const dialog = (page: Page) => page.getByRole("dialog", { name: "画板包" });
const toast = (page: Page) => page.locator(".toast");

async function exportPack(page: Page) {
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导出画板包…" }).click();
}

async function importPack(page: Page, file: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "画板包 ▾" }).click();
  await page.getByRole("menuitem", { name: "导入画板包…" }).click();
  await (await chooser).setFiles(file);
}

/** 预置一个 Flash 图层结果的画板与它引用的任务目录（含 layers.json 与根内参考图）。 */
function layerBoard(title: string) {
  const layers = [
    { file: "layers/01.png", z_index: 1, bounding_box: { absolute: [0, 0, 64, 64], normalized: [0, 0, 1000, 1000] }, name: "主体", description: "红色层" },
    { file: "layers/02.png", z_index: 2, bounding_box: { absolute: [8, 8, 40, 40], normalized: [125, 125, 625, 625] }, name: "点缀", description: "绿色层" },
  ];
  const text = board(
    title,
    [
      promptNode("p1", "本地提示词"),
      { id: "res", type: "result", pos: [400, 0], size: [220, 280], task_id: TASK_ID, file: "result.png", path: `${DIR}/result.png`, layer_count: 2,
        record: { model: "doubao-seedream-5-0-flash-260915", prompt: "p", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T01:00:00Z", layers } },
      referenceNode("ref1", "别处/猫.png", [0, 400]),
    ],
    [],
  );
  return {
    title,
    boardText: text,
    files: {
      [`${DIR}/task.json`]: { text: JSON.stringify({ task_id: TASK_ID, model: "doubao-seedream-5-0-flash-260915", prompt: "p" }) },
      [`${DIR}/result.png`]: { b64: png(64, 64) },
      [`${DIR}/layers.json`]: { text: JSON.stringify({ base: { z_index: 0, file: "result.png" }, layers }) },
      [`${DIR}/layers/01.png`]: { b64: png(64, 64, { alpha: true, rgb: [255, 0, 0] }) },
      [`${DIR}/layers/02.png`]: { b64: png(64, 64, { alpha: true, rgb: [0, 255, 0] }) },
      "别处/猫.png": { b64: png(32, 32) },
    },
  };
}

test("导出画板包是浏览器下载的真 zip：含画板、任务目录、图层与改写后的参考图", async ({ page, rig }) => {
  const errors = await openApp(page, rig, layerBoard("本地"));
  await exportPack(page);
  await expect(dialog(page)).toContainText("将打包画板与它引用的 1 个任务目录、1 张参考图");
  page.on("console", (m) => console.log("BROWSER", m.type(), m.text()));
  page.on("response", (r) => { if (r.url().includes("/api/packs")) console.log("PACKRESP", r.status(), r.url()); });
  const download = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: "导出并下载…" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("本地.ugcpack");
  const bytes = readFileSync((await file.path())!);
  const names = zipNames(bytes);
  expect(names).toEqual(expect.arrayContaining(["manifest.json", "画板/本地.ugcboard.json", `${DIR}/task.json`, `${DIR}/layers.json`, `${DIR}/layers/01.png`, `${DIR}/layers/02.png`, `${DIR}/result.png`]));
  const manifest = JSON.parse(zipText(bytes, "manifest.json"));
  expect(manifest.pack_format_version).toBe(1);
  expect(manifest.app_version).toMatch(/^\d+\.\d+\.\d+/);
  // 根内但不在任务目录的参考图按 sha256 改名打包，画板里的路径同步改写。
  const ref = names.find((n) => /^导入参考图\/[0-9a-f]{64}\.png$/.test(n));
  expect(ref).toBeTruthy();
  expect(zipBytes(bytes, ref!).equals(readFileSync(path.join(rig.userRoot(GOOD_KEY), "别处/猫.png")))).toBe(true);
  const packed = JSON.parse(zipText(bytes, "画板/本地.ugcboard.json"));
  expect(packed.nodes.find((n: { id: string }) => n.id === "ref1").path).toBe(ref);
  await expect(toast(page)).toHaveText("已导出画板包 本地.ugcpack");
  // 导出不在用户数据根留临时文件。
  expect(readdirSync(rig.userRoot(GOOD_KEY)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("导入桌面 v0.3.2 画板包：图层与 layers.json 落盘、画板打开，导入后能继续迭代", async ({ page, rig }) => {
  const errors = await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  await importPack(page, V032);
  await expect(toast(page)).toHaveText("导入 1 个任务，跳过 0 个");
  await expect(page.locator(".tab.tab-active .tab-title")).toHaveText("旧版画板");
  const root = rig.userRoot(GOOD_KEY);
  for (const f of ["task.json", "result.png", "layers.json", "layers/01.png", "layers/02.png"]) {
    expect(existsSync(path.join(root, DIR, f)), `缺 ${f}`).toBe(true);
  }
  expect(existsSync(path.join(root, REF_ENTRY))).toBe(true);
  expect(readJson(path.join(root, DIR, "layers.json")).layers).toHaveLength(2);
  // 上传的临时包已删除。
  expect(existsSync(path.join(root, ".kacha/packs"))).toBe(false);
  // 导入的画板按任务目录真源还原图层。
  await page.locator(`.react-flow__node[data-id="res"] img.thumb`).dblclick();
  await expect(page.getByRole("dialog").locator(".layer-list li")).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).first().click();

  // 继续迭代：任务 t1 引用导入结果的图层2，提交发出该图层的真实字节。
  await page.locator(`.react-flow__node[data-id="t1"]`).locator(".task-actions button.primary").click();
  await expect.poll(() => rig.stub.requests.length).toBe(1);
  const sent = rig.stub.requests[0].body.image as string[];
  expect(sent[0].startsWith("data:image/png;base64,")).toBe(true);
  expect(sent[0]).toBe(`data:image/png;base64,${readFileSync(path.join(root, DIR, "layers/02.png")).toString("base64")}`);
  // 新任务落盘（含结局 / 结果中转提交），导入的画板可继续工作。
  await expect.poll(() => taskRecords(rig).length).toBe(2);
  expect(errors).toEqual([]);
});

test("重复导入同一包：任务目录跳过不覆盖，同名画板改名写入", async ({ page, rig }) => {
  await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  await importPack(page, V032);
  await expect(toast(page)).toHaveText("导入 1 个任务，跳过 0 个");
  const root = rig.userRoot(GOOD_KEY);
  const record = path.join(root, DIR, "task.json");
  const before = readText(record);
  await importPack(page, V032);
  await expect(toast(page)).toHaveText("导入 0 个任务，跳过 1 个");
  expect(readText(record)).toBe(before);
  const boards = readdirSync(path.join(root, "画板")).filter((n) => n.endsWith(".ugcpack.json") || n.endsWith(".ugcboard.json"));
  expect(boards.length).toBeGreaterThanOrEqual(3); // 空 + 两份旧版画板（改名）
});

test("包损坏 / 版本较新：不写任何文件，上传的临时文件也清掉", async ({ page, rig }) => {
  await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  // 真 zip 但含无法识别的路径。
  const bad = makePack(rig, "bad.ugcpack", { "杂项/说明.txt": "x", "画板/旧版画板.ugcboard.json": board("旧版画板", [], []) });
  const before = existsSync(path.join(rig.userRoot(GOOD_KEY), DIR)) ;
  await importPack(page, bad);
  await expect(toast(page)).toContainText("无法导入画板包：包内含无法识别的路径：杂项/说明.txt");
  expect(existsSync(path.join(rig.userRoot(GOOD_KEY), DIR))).toBe(before);
  expect(existsSync(path.join(rig.userRoot(GOOD_KEY), ".kacha/packs"))).toBe(false);
});

test("另一把密钥看不到已上传 / 已导入的画板包（按用户隔离）", async ({ page, rig, request }) => {
  await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  await importPack(page, V032);
  await expect(toast(page)).toHaveText("导入 1 个任务，跳过 0 个");
  const otherRoot = rig.userRoot(OTHER_KEY);
  expect(existsSync(path.join(otherRoot, DIR))).toBe(false);
  // 别的用户的导出不会带出这份内容。
  const res = await request.post(`${rig.localURL}/api/packs/export?op=x1`);
  expect(res.status()).toBe(401);
});

test("磁盘不足（507）时页面提示「服务器空间不足，请联系管理员」", async ({ page, rig }) => {
  await openApp(page, rig, { title: "满", boardText: board("满", [], []) });
  await page.route("**/api/boards?*", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 507, contentType: "application/json", body: JSON.stringify({ code: "insufficient_storage", message: "服务器空间不足，请联系管理员" }) }) : route.continue()));
  await page.getByRole("button", { name: "＋ 提示词", exact: true }).click();
  await expect(page.getByText("服务器空间不足，请联系管理员", { exact: false })).toBeVisible();
});

/** 造一个真 zip 画板包（清单可覆盖版本，附加任意条目）。 */
function makePack(rig: Rig, name: string, entries: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const file = path.join(rig.dataRoot, name);
  const lines = Object.entries(entries).map(([n, t]) => `z.writestr(${JSON.stringify(n)},${JSON.stringify(t)})`);
  return makeZip(rig, file, [
    `z.writestr('manifest.json',${JSON.stringify(JSON.stringify({ pack_format_version: 1, app_version: "9.9.9", boards: ["画板/旧版画板.ugcboard.json"], ...manifest }))})`,
    ...lines,
  ]);
}

function makeZip(rig: Rig, file: string, lines: string[]): string {
  // 用 python 标准库写真 zip：e2e 环境已有 python3，避免给客户端加 zip 依赖。
  execFileSync("python3", ["-I", "-c", `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');${lines.join(";")};z.close()`, file]);
  return file;
}

test("包格式版本较新：弹「无法导入画板包」，不进进度、不写文件", async ({ page, rig }) => {
  await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  const newer = makePack(rig, "newer.ugcpack", {}, { pack_format_version: 2 });
  const alerts: string[] = [];
  page.on("dialog", async (d) => {
    alerts.push(d.message());
    await d.accept();
  });
  await importPack(page, newer);
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain("格式版本 2 高于本机支持的 1（由 9.9.9 导出）");
  expect(existsSync(path.join(rig.userRoot(GOOD_KEY), DIR))).toBe(false);
  await expect(dialog(page)).toHaveCount(0);
  expect(existsSync(path.join(rig.userRoot(GOOD_KEY), ".kacha/packs"))).toBe(false);
});

test("导出缺图：列出缺失并改「仍然导出…」；取消则不产生下载", async ({ page, rig }) => {
  const scn = layerBoard("缺图");
  // 删掉结果图与参考图：导出照常，但要在确认弹窗里列出来。
  scn.files = { [`${DIR}/task.json`]: scn.files![`${DIR}/task.json`] };
  await openApp(page, rig, scn);
  await exportPack(page);
  await expect(dialog(page)).toContainText("以下 4 张图片缺失");
  await expect(dialog(page).getByRole("button", { name: "仍然导出…" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);
});

test("导入后写画板失败：任务目录已导入，弹窗说明写画板失败", async ({ page, rig }) => {
  await openApp(page, rig, { title: "空", boardText: board("空", [], []) });
  await page.route("**/api/boards?*", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 507, contentType: "application/json", body: JSON.stringify({ code: "insufficient_storage", message: "服务器空间不足，请联系管理员" }) }) : route.continue()));
  await importPack(page, V032);
  await expect(dialog(page)).toContainText("导入 1 个任务，跳过 0 个");
  await expect(dialog(page)).toContainText("任务目录已导入，但写画板失败：服务器空间不足，请联系管理员");
  expect(existsSync(path.join(rig.userRoot(GOOD_KEY), DIR, "layers.json"))).toBe(true);
  await dialog(page).getByRole("button", { name: "知道了" }).click();
  await expect(dialog(page)).toHaveCount(0);
});
