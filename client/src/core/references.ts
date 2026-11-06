// 画板文件引用了哪些任务目录：清理未引用任务目录的依据（ADR 0018）。
// 规则定义在画板文件格式（JSON 原文）上，与服务端 server/src/references.rs 逐条对应，
// 两侧共用 contracts/fixtures/board-references/ 夹具。改这里必须同步改服务端。
import { BOARD_FORMAT_VERSION, copyTaskIds } from "./board";
import { taskDirOfRelPath, taskDirOfTaskId } from "./taskDir";

/** readable=false：画板读不懂（损坏 / 版本更高），不能当成没有引用。 */
export type BoardReferences = { readable: true; taskDirs: string[] } | { readable: false };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function addPath(out: Set<string>, v: unknown) {
  if (typeof v !== "string") return;
  const dir = taskDirOfRelPath(v);
  if (dir) out.add(dir);
}

function addTaskId(out: Set<string>, v: unknown) {
  if (typeof v !== "string") return;
  const dir = taskDirOfTaskId(v);
  if (dir) out.add(dir);
}

/** 读不懂的节点：其中任何像任务目录路径或任务编号的字符串都算引用（保守）。 */
function addDeep(out: Set<string>, v: unknown) {
  if (typeof v === "string") {
    addPath(out, v);
    addTaskId(out, v);
  } else if (Array.isArray(v)) v.forEach((x) => addDeep(out, x));
  else if (isObject(v)) Object.values(v).forEach((x) => addDeep(out, x));
}

function addNode(out: Set<string>, node: unknown) {
  if (!isObject(node)) return addDeep(out, node);
  switch (node.type) {
    case "prompt":
      return;
    case "reference":
      return addPath(out, node.path);
    case "result":
      addPath(out, node.path);
      return addTaskId(out, node.task_id);
    case "task": {
      const last = node.last_submitted;
      if (!isObject(last)) return;
      addTaskId(out, last.task_id);
      // 同一次提交按份数展开的各份（失败 / 已取消 / 已中断的份没有结果节点，只靠这里引用）。
      copyTaskIds(last).forEach((id) => addTaskId(out, id));
      if (Array.isArray(last.images))
        for (const image of last.images) {
          if (!isObject(image)) continue;
          addTaskId(out, image.task_id);
          addPath(out, image.path);
        }
      return;
    }
    default:
      return addDeep(out, node);
  }
}

export function boardFileReferences(text: string): BoardReferences {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { readable: false };
  }
  if (!isObject(raw)) return { readable: false };
  const version = raw.format_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > BOARD_FORMAT_VERSION) return { readable: false };
  if (!Array.isArray(raw.nodes)) return { readable: false };
  const out = new Set<string>();
  raw.nodes.forEach((n) => addNode(out, n));
  return { readable: true, taskDirs: [...out].sort() };
}
