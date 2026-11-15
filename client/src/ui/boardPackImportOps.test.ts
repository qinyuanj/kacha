// 画板包导入的接线（#137）：选文件、画板位预检与结局。
import { describe, expect, it, vi } from "vitest";
import { packImportOutcome, type PackImportDeps } from "./boardPackImportOps";

const noop = () => () => undefined;
const noPhase = () => undefined;

function deps(patch: Partial<PackImportDeps> = {}): PackImportDeps {
  return {
    pickPackFile: async () => new File(["x"], "包.ugcpack"),
    import: async () => ({ kind: "done", summary: { imported: 0, skipped: 0, conflicts: [], message: "已导入" }, written: [], writeError: null }),
    listSlots: async () => ({ used: 1, total: 10 }),
    openBoard: async () => undefined,
    log: () => undefined,
    ...patch,
  };
}

describe("导入的接线", () => {
  it("没有选文件：什么都不做", async () => {
    const outcome = await packImportOutcome(deps({ pickPackFile: async () => null }), noop, noPhase);
    expect(outcome.kind).toBe("failed");
  });

  it("导入成功：提示结局", async () => {
    const outcome = await packImportOutcome(deps(), noop, noPhase);
    expect(outcome.kind).toBe("toast");
  });

  it("导入抛错：给失败提示", async () => {
    const outcome = await packImportOutcome(
      deps({
        import: async () => {
          throw new Error("offline");
        },
      }),
      noop,
      noPhase,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.text).toContain("offline");
  });

  it("画板位预检：问一次画板位，放不下时给出统一文案", async () => {
    const listSlots = vi.fn(async () => ({ used: 10, total: 10 }));
    let refusal: string | null = null;
    const outcome = await packImportOutcome(
      deps({
        listSlots,
        import: async (_file, options) => {
          refusal = (await options.slotsRefusal?.(1)) ?? null;
          return { kind: "done", summary: { imported: 0, skipped: 0, conflicts: [], message: "已导入" }, written: [], writeError: null };
        },
      }),
      noop,
      noPhase,
    );
    expect(listSlots).toHaveBeenCalled();
    expect(refusal).toContain("画板位满了");
    expect(outcome.kind).toBe("toast");
  });
});
