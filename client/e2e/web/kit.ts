// 画板 / 任务场景工具：直接向每测试的临时用户数据根预置文件，再真登录进入。
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

export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/**
 * 已落盘画板的节点。画布只渲染视口内的节点（#66），视口外的节点不在 DOM 中：
 * 数节点、找新建节点的 id 以画板文件为准，不数 `.react-flow__node`。
 */
export function savedNodes(rig: Rig, title: string, key = GOOD_KEY): { id: string; type: string; pos: [number, number] }[] {
  const file = path.join(rig.userRoot(key), boardRelPath(title));
  return existsSync(file) ? readJson(file).nodes : [];
}
export const readText = (path: string) => readFileSync(path, "utf8");

export interface DroppedFile {
  name: string;
  mimeType: string;
  /** 文件内容（base64）。 */
  b64: string;
}

/** 模拟从本机 HTML5 拖入一个文件，落在画布的页面坐标 (x, y) 处：依次派发 dragover 与 drop。 */
export async function dropFile(page: Page, file: DroppedFile, at: { x: number; y: number }) {
  await page.evaluate(
    ({ file, at }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))], file.name, { type: file.mimeType }));
      const el = document.querySelector(".canvas")!;
      for (const type of ["dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at.x, clientY: at.y }));
    },
    { file, at },
  );
}

/**
 * 模拟把一张图片放进系统剪贴板后按 Ctrl+V：先把指针移到画布的页面坐标 (x, y)，
 * 再在页面里合成一次 paste 事件——粘贴落点取「鼠标最后在画布内的位置」，所以先要一次指针移动。
 *
 * 为什么合成事件：页面跑在内网 HTTP 上不是安全上下文，navigator.clipboard 不存在，
 * e2e 没法真的写系统剪贴板（与 dropFile 只能合成 drop 同一路数）。clipboardData 直接挂到
 * 事件上而不走构造参数：有的浏览器不接受 ClipboardEvent 构造参数里的 clipboardData。
 */
export async function pasteImage(page: Page, file: DroppedFile, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.evaluate((file) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))], file.name, { type: file.mimeType }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: dt });
    document.body.dispatchEvent(event);
  }, file);
}

/**
 * 模拟只经「图片条目」暴露的剪贴板：没有文件列表，只有 items 里的一条 kind==="file" 条目。
 * 系统截图、网页「复制图片」给的就是这种形状（数据在条目里，不在文件列表里）。
 * DataTransfer 加了文件后 files 与 items 会同时有它，所以这里自己拼一个只有条目的剪贴板。
 */
export async function pasteImageItem(page: Page, file: DroppedFile, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.evaluate((file) => {
    const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
    const real = new File([bytes], file.name, { type: file.mimeType });
    const clipboard = {
      files: [],
      items: [{ kind: "file", type: file.mimeType, getAsFile: () => real }],
      getData: () => "",
    };
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    document.body.dispatchEvent(event);
  }, file);
}
