// 手工构造的包格式 v2 夹具（#57）：内容相同的条目只存一份，其余路径记在 manifest.json 的 duplicates 里。
// 任务 B 的参考图快照是任务 A 的结果图（迭代时的典型重复），画板里另有一个参考图节点直接引用这份被省略的快照。
// 产物 v2-duplicates.ugcpack 已提交，web e2e 使用；改动这里要重新运行并提交。
// 用法：node generate-v2.ts
import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { board, png, referenceNode } from "../../e2e/common/boards.ts";

export const TASK_A = "20260916T010000Z-0000000a";
export const TASK_B = "20260916T020000Z-0000000b";
export const DIR_A = `2026-09-16/${TASK_A}`;
export const DIR_B = `2026-09-16/${TASK_B}`;
export const BOARD_FILE = "去重画板.ugcboard.json";

const resultA = Buffer.from(png(64, 64, { rgb: [80, 120, 200] }), "base64");
const resultB = Buffer.from(png(64, 64, { rgb: [200, 80, 80] }), "base64");
const SNAPSHOT = `${DIR_B}/references/01.png`;

const record = (taskId: string, submittedAt: string, references: unknown[] = []) => ({
  task_id: taskId,
  submitted_at: submittedAt,
  model: "qwen-image-3.0-pro",
  prompt: "p",
  negative_prompt: "",
  size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
  references,
});
const recordA = record(TASK_A, "2026-09-16T01:00:00.000Z");
const recordB = record(TASK_B, "2026-09-16T02:00:00.000Z", [{ file: "references/01.png", source: { kind: "result", path: `${DIR_A}/result.png` } }]);
const resultNode = (id: string, taskId: string, dir: string, rec: Record<string, unknown>, pos: [number, number]) => ({
  id, type: "result", pos, size: [220, 280], task_id: taskId, file: "result.png", path: `${dir}/result.png`, layer_count: 0,
  record: { model: rec.model, prompt: rec.prompt, negative_prompt: "", size_spec: rec.size_spec, submitted_at: rec.submitted_at },
});

const boardText = board(
  "去重画板",
  [resultNode("ra", TASK_A, DIR_A, recordA, [0, 0]), resultNode("rb", TASK_B, DIR_B, recordB, [300, 0]), referenceNode("snap", SNAPSHOT, [600, 0])],
  [],
);

const entries: [string, Buffer][] = [
  ["manifest.json", Buffer.from(JSON.stringify({ pack_format_version: 2, app_version: "0.4.0", boards: [`画板/${BOARD_FILE}`], duplicates: { [SNAPSHOT]: `${DIR_A}/result.png` } }, null, 2))],
  [`画板/${BOARD_FILE}`, Buffer.from(boardText)],
  [`${DIR_A}/result.png`, resultA],
  [`${DIR_A}/task.json`, Buffer.from(JSON.stringify(recordA))],
  [`${DIR_B}/result.png`, resultB],
  [`${DIR_B}/task.json`, Buffer.from(JSON.stringify(recordB))],
];

/** 最小 zip 写入：全部 store、UTF-8 文件名（flag bit 11），不需要第三方库。 */
function zip(files: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL("./v2-duplicates.ugcpack", import.meta.url);
  writeFileSync(out, zip(entries));
  console.log(`已生成 ${out.pathname}`);
}
