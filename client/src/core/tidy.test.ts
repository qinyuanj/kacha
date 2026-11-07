import { describe, expect, it } from "vitest";
import { boardBytes, nodesBytes, pruneSavings, type BoardMeasure } from "./tidy";

const A = "2026-10-01/a";
const B = "2026-10-02/b";
const C = "2026-10-03/c";
const D = "2026-10-04/d";
const E = "2026-10-05/e";

/** r1 与参考图 ref 共用任务目录 A；E 只被一个没有 id 的节点引用（不归任何节点，但算在画板里）。 */
const measure: BoardMeasure = {
  nodes: { r1: [A], ref: [A], r2: [B], t: [C], r3: [D] },
  dirs: { [A]: 1000, [B]: 300, [C]: 50, [D]: 7, [E]: 5 },
};

describe("整理模式的体量（按任务目录，与画板体量同一口径）", () => {
  it("画板体量 = 引用的各任务目录字节之和", () => {
    expect(boardBytes(measure)).toBe(1362);
  });

  it("一组节点（如一个阶段）的体量：它们引用的任务目录各算一次；不认识的节点按 0", () => {
    expect(nodesBytes(measure, ["r1", "ref", "r2"])).toBe(1300);
    expect(nodesBytes(measure, ["t", "gone"])).toBe(50);
    expect(nodesBytes(measure, [])).toBe(0);
  });

  it("收掉一些节点预计减少的体量：只算不再被其它节点引用的任务目录", () => {
    // 参考图还引用着 A：收掉 r1 画板不会变小。
    expect(pruneSavings(measure, ["r1"])).toBe(0);
    expect(pruneSavings(measure, ["r1", "ref"])).toBe(1000);
    expect(pruneSavings(measure, ["r2", "r3"])).toBe(307);
    expect(pruneSavings(measure, [])).toBe(0);
  });
});
