import { describe, expect, it } from "vitest";
import { toImportResult } from "./fakePortStores";
import type { FakeImportOutcome } from "./fakePortTypes";

// 替身把脚本化导入结局折成 core 的 ImportResult，界面按 kind 分派。
// 七个结局逐一钉住：错也要错得对——corrupt / newer / cancelled 这三条从未被界面测试走过，
// 而它们正是「导入失败时界面说哪句话」的依据。
const cases: { name: string; outcome: FakeImportOutcome; expected: unknown }[] = [
  {
    name: "done：计数、冲突清单与写入路径原样带出，未给 writeError 时是 null",
    outcome: { kind: "done", summary: { imported: 2, skipped: 1, conflicts: ["冲突A"], message: "已导入 3 块" }, written: ["/~/画板/a.ugcboard.json"] },
    expected: { kind: "done", summary: { imported: 2, skipped: 1, conflicts: ["冲突A"], message: "已导入 3 块" }, written: ["/~/画板/a.ugcboard.json"], writeError: null },
  },
  {
    name: "done：writeError 有值时原样带出",
    outcome: { kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入 1 块" }, written: [], writeError: "打开失败：权限不足" },
    expected: { kind: "done", summary: { imported: 1, skipped: 0, conflicts: [], message: "已导入 1 块" }, written: [], writeError: "打开失败：权限不足" },
  },
  {
    name: "partial：折成 done，计数固定 1 导 1 跳，不写任何路径",
    outcome: { kind: "partial", message: "部分导入", conflicts: ["冲突B"] },
    expected: { kind: "done", summary: { imported: 1, skipped: 1, conflicts: ["冲突B"], message: "部分导入" }, written: [], writeError: null },
  },
  {
    name: "failed：折成 commitFailed，带原始错误",
    outcome: { kind: "failed", error: "磁盘已满" },
    expected: { kind: "commitFailed", error: "磁盘已满" },
  },
  {
    name: "slotsFull：折成 slotsFull，带提示文案",
    outcome: { kind: "slotsFull", message: "画板位已满" },
    expected: { kind: "slotsFull", message: "画板位已满" },
  },
  {
    name: "corrupt：折成 corrupt，带原因",
    outcome: { kind: "corrupt", reason: "不是合法的画板包" },
    expected: { kind: "corrupt", reason: "不是合法的画板包" },
  },
  {
    name: "newer：折成 newer，带提示文案",
    outcome: { kind: "newer", message: "这个画板包来自更新的版本" },
    expected: { kind: "newer", message: "这个画板包来自更新的版本" },
  },
  {
    name: "cancelled：折成 cancelled",
    outcome: { kind: "cancelled" },
    expected: { kind: "cancelled" },
  },
];

describe("toImportResult：脚本化导入结局 → core ImportResult", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(toImportResult(c.outcome)).toEqual(c.expected);
    });
  }
});
