// 新接缝的画板 / 任务场景工具：直接向每测试的临时用户数据根预置文件（等价于旧假壳的场景注入），再真登录进入。
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { enterWithKey, expect, GOOD_KEY, type Rig } from "./rig";
import { MODELS, task } from "../common/boards";

export { task };

export type SeedFile = { text: string } | { b64: string };

export interface WebScenario {
  title: string;
  boardText: string;
  /** 相对用户数据根的路径 → 内容（参考图、任务目录等）。 */
  files?: Record<string, SeedFile>;
  settings?: string | null;
  modelsCache?: string | null;
  capabilityOverride?: string | null;
  key?: string;
}

export const boardRelPath = (title: string) => `画板/${title}.ugcboard.json`;

function write(root: string, rel: string, data: string | Buffer) {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
}

/** 预置画板、引用文件与元数据；返回画板的相对路径。 */
export function seed(rig: Rig, scn: WebScenario): string {
  const key = scn.key ?? GOOD_KEY;
  const root = rig.userRoot(key);
  const rel = boardRelPath(scn.title);
  write(root, rel, scn.boardText);
  for (const [p, content] of Object.entries(scn.files ?? {})) write(root, p, "text" in content ? content.text : Buffer.from(content.b64, "base64"));
  const settings = scn.settings ?? JSON.stringify({ format_version: 1, base_url: rig.stub.url, concurrency: 4 });
  write(root, ".kacha/settings.json", settings);
  write(root, ".kacha/models-cache.json", scn.modelsCache ?? JSON.stringify({ base_url: rig.stub.url, model_ids: MODELS, fetched_at: new Date().toISOString() }));
  if (scn.capabilityOverride) write(root, ".kacha/capabilities.override.json", scn.capabilityOverride);
  write(root, ".kacha/ui-state.json", JSON.stringify({ window: null, open_boards: [`/~/${rel}`], active_board: `/~/${rel}` }));
  return rel;
}

/** 预置场景并进入工作台，等画板真的打开；返回页面级 JS 错误列表。 */
export async function openApp(page: Page, rig: Rig, scn: WebScenario): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  seed(rig, scn);
  // 同一页面换场景：已在工作台里时直接刷新（登录表单只在未进入时出现）。
  if (page.url().startsWith(rig.baseURL) && (await page.getByLabel("API 密钥", { exact: true }).count()) === 0) await page.reload();
  else await enterWithKey(page, rig.baseURL, scn.key ?? GOOD_KEY);
  await expect(page.locator(".tab.tab-active .tab-title")).toHaveText(scn.title);
  return errors;
}

/** 该用户全部任务目录里的 task.json（含绝对路径）。 */
export function taskRecords(rig: Rig, key = GOOD_KEY): { path: string; json: Record<string, any> }[] {
  const root = rig.userRoot(key);
  if (!existsSync(root)) return [];
  const out: { path: string; json: Record<string, any> }[] = [];
  for (const date of readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const id of readdirSync(path.join(root, date))) {
      const file = path.join(root, date, id, "task.json");
      if (existsSync(file)) out.push({ path: file, json: JSON.parse(readFileSync(file, "utf8")) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function taskDir(rig: Rig, taskId: string, key = GOOD_KEY): string {
  const record = taskRecords(rig, key).find((r) => r.json.task_id === taskId);
  if (!record) throw new Error(`找不到任务目录：${taskId}`);
  return path.dirname(record.path);
}

export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export const readText = (path: string) => readFileSync(path, "utf8");
