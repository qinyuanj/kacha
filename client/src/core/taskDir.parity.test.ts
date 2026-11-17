// 任务目录规则（ADR 0010）的跨语言 parity：Go 侧 desktop/internal/taskref 与这里共用
// contracts/task-dir-refs.json 的同一批用例。两边各写一套实现，靠这份夹具保证给出同一个答案。
import { describe, expect, it } from "vitest";
import fixture from "../../../contracts/task-dir-refs.json" with { type: "json" };
import { parseBoard } from "./board";
import { planExport, type PackFs } from "./boardPack";
import { taskDirOfRelPath, taskDirOfTaskId } from "./taskDir";

const ROOT = "/~";

/** 夹具里的文件都在盘上：这里只比「认哪些任务目录」，不模拟缺图。 */
const presentFs: PackFs = {
  isFile: async () => true,
  sha256: async () => "0".repeat(64),
};

describe("任务目录规则与 Go 侧一致", () => {
  it("相对路径 → 任务目录", () => {
    for (const { rel, task_dir } of fixture.paths) {
      expect(taskDirOfRelPath(rel), rel).toBe(task_dir);
    }
  });

  it("任务编号 → 任务目录", () => {
    for (const { task_id, task_dir } of fixture.task_ids) {
      expect(taskDirOfTaskId(task_id), task_id).toBe(task_dir);
    }
  });

  it("同一批画板 JSON 认出的任务目录与 Go 侧一致", async () => {
    for (const { name, board, task_dirs } of fixture.boards) {
      const parsed = parseBoard(JSON.stringify(board));
      expect(parsed.kind, name).toBe("ok");
      if (parsed.kind !== "ok") continue;
      const plan = await planExport(parsed.board, ROOT, presentFs);
      expect(plan.taskDirs, name).toEqual([...task_dirs].sort());
    }
  });
});
