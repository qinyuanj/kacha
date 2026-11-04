// 顶栏备份提示、高级设置用量与自助清理（#25）：真服务端 + 每测试临时数据根。
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test, expect, GOOD_KEY } from "./rig";
import { openApp } from "./kit";
import { png } from "../common/boards";
import { statSync, utimesSync } from "node:fs";

const DAY = 86400;
const OLD = "2026-10-01/20261001T000000Z-0000000a";
const KEPT = "2026-10-02/20261002T000000Z-0000000b";
const YOUNG = "2027-01-01/20270101T000000Z-0000000d";

const bytesLabel = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);
const keptPng = Buffer.from(png(8, 8), "base64");
const keptBytes = 2 + keptPng.length;

const base = {
  format_version: 1,
  title: "用量",
  viewport: { zoom: 1, x: 0, y: 0 },
  edges: [] as unknown[],
  nodes: [] as unknown[],
};

function resultNode(dir: string) {
  const task_id = dir.split("/")[1];
  return { id: "r", type: "result", pos: [0, 0], size: [220, 280], task_id, file: "result.png", path: `${dir}/result.png`, layer_count: 0, record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-10-02T00:00:00Z" } };
}

test("顶栏常驻备份提示", async ({ page, rig }) => {
  await openApp(page, rig, { title: "用量", boardText: JSON.stringify(base) });
  const hint = page.locator(".topbar-backup-hint");
  await expect(hint).toHaveText("服务端不备份；60 天未使用的数据可能被清理，请定期导出画板包");
  await expect(hint).toBeVisible();
});

test("高级设置显示用量，预览未引用任务目录，取消不动磁盘，确认后进回收区", async ({ page, rig }) => {
  const root = rig.userRoot(GOOD_KEY);
  await openApp(page, rig, {
    title: "用量",
    boardText: JSON.stringify({ ...base, nodes: [resultNode(KEPT)] }),
    files: {
      [`${OLD}/task.json`]: { text: "{}" },
      [`${OLD}/result.png`]: { text: "x".repeat(1000) },
      [`${KEPT}/task.json`]: { text: "{}" },
      [`${KEPT}/result.png`]: { b64: png(8, 8) },
      [`${YOUNG}/task.json`]: { text: "{}" },
    },
  });
  const now = Math.floor(Date.now() / 1000);
  for (const [dir, days] of [[OLD, 100], [KEPT, 100], [YOUNG, 14]] as const) setAge(path.join(root, dir), now - days * DAY);
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  const panel = page.getByRole("dialog", { name: "高级设置" });
  // 用量：总量 = 全部文件字节之和；只列 OLD 一个未引用任务目录。
  const total = dirBytes(root);
  await expect(panel.getByTestId("usage-total")).toHaveText(bytesLabel(total));
  await expect(panel.getByTestId("usage-dates")).toContainText("2026-10-01");
  await expect(panel.getByTestId("usage-dates")).toContainText(`${keptBytes} B`);
  await expect(panel.getByTestId("usage-dates")).toContainText("2027-01-01");
  await expect(panel.getByTestId("usage-unreferenced-summary")).toHaveText("1 个未引用任务目录，共 1002 B");
  await panel.getByRole("button", { name: "清理未引用任务目录…" }).click();
  const dialog = page.getByRole("dialog", { name: "清理未引用任务目录" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("li")).toHaveCount(1);
  await expect(dialog.locator("li")).toContainText(OLD);
  await expect(dialog.locator("li")).toContainText("1002 B");
  await expect(dialog).toContainText("回收区");
  await dialog.getByRole("button", { name: "取消" }).click();
  expect(existsSync(path.join(root, OLD))).toBe(true);

  await panel.getByRole("button", { name: "清理未引用任务目录…" }).click();
  await dialog.getByRole("button", { name: "移入回收区", exact: true }).click();
  await expect.poll(() => existsSync(path.join(root, OLD))).toBe(false);
  expect(existsSync(path.join(root, KEPT))).toBe(true);
  expect(existsSync(path.join(root, YOUNG))).toBe(true);
  const batches = readdirSync(path.join(rig.dataRoot, "recycle"));
  expect(batches).toHaveLength(1);
  expect(existsSync(path.join(rig.dataRoot, "recycle", batches[0], "users", path.basename(root), OLD, "result.png"))).toBe(true);
  await expect(panel.getByTestId("usage-unreferenced-summary")).toHaveText("没有未引用任务目录");
  await expect(panel.getByTestId("usage-total")).toHaveText(bytesLabel(dirBytes(root)));
  // 日期目录里已没有任务，整行消失。
  await expect(panel.getByTestId("usage-dates")).not.toContainText("2026-10-01");
});

test("画板读不懂时不提供自助清理", async ({ page, rig }) => {
  await openApp(page, rig, {
    title: "用量",
    boardText: JSON.stringify(base),
    files: { [`${OLD}/task.json`]: { text: "{}" }, "画板/坏.ugcboard.json": { text: "{ not json" } },
  });
  await page.getByRole("button", { name: "⚙ 高级设置" }).click();
  const panel = page.getByRole("dialog", { name: "高级设置" });
  await expect(panel.getByTestId("usage-unreadable")).toContainText("画板/坏.ugcboard.json");
  await expect(panel.getByRole("button", { name: "清理未引用任务目录…" })).toBeDisabled();
});

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) total += dirBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

/** 目录建立时间：把整棵树修改时间设到指定 Unix 秒（服务端取 task_id 与 mtime 中较晚者）。 */
function setAge(dir: string, at: number) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) setAge(p, at);
    else utimesSync(p, at, at);
  }
  utimesSync(dir, at, at);
}
