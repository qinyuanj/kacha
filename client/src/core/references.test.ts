import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boardFileReferences } from "./references";

// 与服务端清理（server/tests/references.rs）共用同一组夹具，结论必须一致。
const fixture = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/board-references/cases.json", import.meta.url), "utf8")) as {
  cases: { name: string; board?: unknown; board_text?: string; expected: { readable: boolean; task_dirs?: string[] } }[];
};

describe("画板引用的任务目录（共享夹具）", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const text = c.board_text ?? JSON.stringify(c.board);
      const got = boardFileReferences(text);
      expect(got.readable ? { readable: true, task_dirs: got.taskDirs } : { readable: false }).toEqual(c.expected);
    });
  }
});
