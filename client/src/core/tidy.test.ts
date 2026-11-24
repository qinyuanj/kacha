import { describe, expect, it } from "vitest";
import { boardBytes, type BoardMeasure } from "./tidy";

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
});
