// Flash 图层任务目录夹具：底图 + 两个 alpha 图层 + layers.json 真源（夹具供 layers-exchange.spec 使用；layers.spec 只用 FLASH 常量）。
import { board } from "./boards";
import { png } from "./boards";
import type { SeedFile } from "../web/kit";

export const FLASH = "doubao-seedream-5-0-flash-260915";
export const TASK_ID = "20260916T010000Z-0000000a";
export const DIR = `2026-09-16/${TASK_ID}`;
export const BASE = png(64, 64);
export const L1 = png(64, 64, { alpha: true, rgb: [255, 0, 0] });
export const L2 = png(64, 64, { alpha: true, rgb: [0, 255, 0] });
export const BOX1 = { absolute: [0, 0, 64, 64], normalized: [0, 0, 1000, 1000] };
export const BOX2 = { absolute: [8, 8, 40, 40], normalized: [125, 125, 625, 625] };

/** 任务目录真源 layers.json：底图身份 + 两层完整元数据。 */
export const layersJson = () =>
  JSON.stringify({
    base: { z_index: 0, name: "合成底图", description: "底图说明" },
    layers: [
      { file: "layers/01.png", z_index: 1, bounding_box: BOX1, name: "主体", description: "红色层" },
      { file: "layers/02.png", z_index: 2, bounding_box: BOX2, name: "点缀", description: "绿色层" },
    ],
  });

/** Flash 结果节点：画板里只留最小记录（无图层副本），靠打开时按真源还原。 */
export const flashResult = (id: string, pos: [number, number] = [800, 0]) => ({
  id,
  type: "result",
  pos,
  size: [220, 280],
  task_id: TASK_ID,
  file: "result.png",
  path: `${DIR}/result.png`,
  layer_count: 0,
  record: { model: FLASH, prompt: "p", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-09-16T01:00:00Z" },
});

export const taskFiles = (withLayer2 = true): Record<string, SeedFile> => ({
  [`${DIR}/task.json`]: { text: JSON.stringify({ task_id: TASK_ID, model: FLASH, prompt: "p", size: { width: 64, height: 64 }, references: [] }) },
  [`${DIR}/result.png`]: { b64: BASE },
  [`${DIR}/layers.json`]: { text: layersJson() },
  [`${DIR}/layers/01.png`]: { b64: L1 },
  ...(withLayer2 ? { [`${DIR}/layers/02.png`]: { b64: L2 } } : {}),
});

export const boardWithResult = (title: string) => board(title, [flashResult("res")], []);
