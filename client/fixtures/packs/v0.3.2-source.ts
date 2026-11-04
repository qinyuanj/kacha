// v0.3.2 画板包夹具的源数据：桌面版输出根目录（Flash 图层结果 + layers.json + 根外参考图）与 v0.3.2 前端
// planExport / buildExportSpec 会交给 Rust 壳的导出规格。由 generate-v0.3.2.sh 调用，再用 tag v0.3.2 的
// board_pack.rs 打包；改动这里要重新生成并提交 .ugcpack。
// 用法：node v0.3.2-source.ts <输出根目录> <根外参考图路径> <spec.json>
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { board, edge, png, promptNode, taskNode } from "../../e2e/common/boards.ts";

export const FLASH = "doubao-seedream-5-0-flash-260915";
export const TASK_ID = "20260916T010000Z-0000000a";
export const DIR = `2026-09-16/${TASK_ID}`;
export const BOARD_FILE = "旧版画板.ugcboard.json";
const BOX1 = { absolute: [0, 0, 64, 64], normalized: [0, 0, 1000, 1000] };
const BOX2 = { absolute: [8, 8, 40, 40], normalized: [125, 125, 625, 625] };
const LAYERS = [
  { file: "layers/01.png", z_index: 1, bounding_box: BOX1, name: "主体", description: "红色层" },
  { file: "layers/02.png", z_index: 2, bounding_box: BOX2, name: "点缀", description: "绿色层" },
];

const [root, refPath, specPath] = process.argv.slice(2);
const write = (file: string, data: string | Buffer) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const bytes = (b64: string) => Buffer.from(b64, "base64");

const taskRecord = {
  task_id: TASK_ID,
  submitted_at: "2026-09-16T01:00:00.000Z",
  workflow: "text_to_image",
  model: FLASH,
  capability_format_version: 1,
  capability_table_sha256: "0".repeat(64),
  prompt: "一只红色的猫和绿色的点缀",
  negative_prompt: "",
  send_text: "一只红色的猫和绿色的点缀",
  size_spec: { tier: "2K", ratio: "1:1", width: null, height: null },
  size: { width: 64, height: 64 },
  layer_decomposition: true,
  transparent_background: false,
  references: [],
};
write(path.join(root, DIR, "task.json"), `${JSON.stringify(taskRecord, null, 2)}\n`);
write(path.join(root, DIR, "result.png"), bytes(png(64, 64)));
write(path.join(root, DIR, "layers.json"), JSON.stringify({ base: { z_index: 0, name: "合成底图", description: "底图说明", file: "result.png" }, layers: LAYERS }));
write(path.join(root, DIR, "layers/01.png"), bytes(png(64, 64, { alpha: true, rgb: [255, 0, 0] })));
write(path.join(root, DIR, "layers/02.png"), bytes(png(64, 64, { alpha: true, rgb: [0, 255, 0] })));
const ref = bytes(png(32, 32, { rgb: [200, 200, 0] }));
write(refPath, ref);
const refEntry = `导入参考图/${createHash("sha256").update(ref).digest("hex")}.png`;

// v0.3.2 planExport 的产物：任务目录内路径相对化，根外参考图改写为导入参考图下的包内路径。
const result = {
  id: "res", type: "result", pos: [0, 300], size: [220, 280], task_id: TASK_ID, file: "result.png", path: `${DIR}/result.png`, layer_count: 2,
  record: { model: FLASH, prompt: taskRecord.prompt, negative_prompt: "", size_spec: taskRecord.size_spec, submitted_at: taskRecord.submitted_at, layers: LAYERS },
};
const reference = { id: "ref1", type: "reference", pos: [0, 700], size: [200, 200], path: refEntry, sha256: refEntry.slice(6, 70), display_name: "猫.png" };
const boardText = board(
  "旧版画板",
  [promptNode("p1", "把图层2 变成蓝色"), result, reference, taskNode("t1", { model: FLASH, image_ports: 1 })],
  [edge("p1", "t1", "positive"), edge("res", "t1", "image:0", { source_layer: 2 })],
);
const manifest = `${JSON.stringify({ pack_format_version: 1, app_version: "0.3.2", boards: [`画板/${BOARD_FILE}`] }, null, 2)}\n`;
const spec = {
  texts: [
    { entry: "manifest.json", text: manifest },
    { entry: `画板/${BOARD_FILE}`, text: `${boardText}\n` },
  ],
  task_dirs: [DIR],
  files: [{ source: refPath, entry: refEntry }],
};
writeFileSync(specPath, JSON.stringify(spec));
