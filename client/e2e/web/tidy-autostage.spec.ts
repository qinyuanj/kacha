// 自动划分阶段（#143）：整理条上点一下，画板按「一次生成尝试」划出阶段；再点一次是空操作。
// 阶段框上的细节动作（建议保留、保留这 N 张、收掉整板未定稿）由 canvasOverlays / stages 的组件用例覆盖。
import { readFileSync } from "node:fs";
import path from "node:path";
import { board, edge, png, promptNode, taskNode } from "../common/boards";
import { TIDY_TEXT } from "../../src/ui/boardText";
import { openApp } from "./kit";
import { GOOD_KEY, expect, test, type Rig } from "./rig";

const TITLE = "自动划分";
const ID = "20260916T091500Z-c0ffee01";
const DIR = `2026-09-16/${ID}`;
const MODEL = "qwen-image-3.0-pro";
const size = { tier: "1K", ratio: "1:1", width: null, height: null };
const record = {
  task_id: ID,
  submitted_at: "2026-09-16T09:15:00Z",
  workflow: "text_to_image",
  model: MODEL,
  capability_format_version: 1,
  capability_table_sha256: "a".repeat(64),
  prompt: "一只猫",
  negative_prompt: "",
  send_text: "一只猫",
  size_spec: size,
  size: { width: 1024, height: 1024 },
  layer_decomposition: false,
  transparent_background: false,
  references: [],
};
const last = { task_id: ID, model: MODEL, prompt: "一只猫", negative_prompt: "", size_spec: size, images: [], layer_decomposition: false, transparent_background: false };

/** 一次生成尝试：提示词喂给任务，任务经系统连线指向结果——三个成员，划得出一个阶段。 */
const attempt = () =>
  board(
    TITLE,
    [
      promptNode("p", "一只猫"),
      taskNode("t", { model: MODEL, size_spec: size, last_submitted: last }),
      {
        id: "r", type: "result", pos: [850, 0], size: [200, 220], task_id: ID, file: "result.png", path: `${DIR}/result.png`, layer_count: 0,
        record: { model: MODEL, prompt: "一只猫", negative_prompt: "", size_spec: size, submitted_at: record.submitted_at },
      },
    ],
    [edge("p", "t", "positive"), edge("t", "r", "in", { system: true, from: ["t", "result"] })],
  );

/** 画板存盘里的阶段（自动保存有去抖，断言用 poll 等它落盘）。 */
const stagesOf = (rig: Rig) => JSON.parse(readFileSync(path.join(rig.userRoot(GOOD_KEY), "画板", `${TITLE}.ugcboard.json`), "utf8")).stages ?? [];

test("整理模式点「自动划分阶段」按一次生成尝试划出阶段，再点一次不动画板", async ({ page, rig }) => {
  await openApp(page, rig, {
    title: TITLE,
    boardText: attempt(),
    files: { [`${DIR}/task.json`]: { text: JSON.stringify(record) }, [`${DIR}/result.png`]: { b64: png(1024, 1024) } },
  });
  await page.getByRole("button", { name: TIDY_TEXT.enter, exact: true }).click();
  await expect(page.getByRole("status", { name: "整理模式" })).toBeVisible();

  // 进整理模式只是看：还没写画板，按钮上现算出会建 1 个阶段。
  expect(stagesOf(rig)).toEqual([]);
  const auto = page.getByRole("button", { name: TIDY_TEXT.autoStages(1), exact: true });
  await expect(auto).toBeEnabled();
  await auto.click();

  // 点下去才是画板变更：阶段框出现，名字沿用「阶段 N」，成员是一次尝试的提示词、任务与结果。
  await expect(page.locator(".stage-frame .stage-name")).toHaveText("阶段 1");
  await expect.poll(() => stagesOf(rig).length).toBe(1);
  expect([...stagesOf(rig)[0].nodes].sort()).toEqual(["p", "r", "t"]);

  // 已经进过阶段的节点不再被碰：再点一次没有候选，按钮置灰且说明原因。
  const again = page.getByRole("button", { name: TIDY_TEXT.autoStages(0), exact: true });
  await expect(again).toBeDisabled();
  await expect(again).toHaveAttribute("title", TIDY_TEXT.autoStagesEmpty);
});
