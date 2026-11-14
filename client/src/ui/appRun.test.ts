// 运行与重新生成的判定（#137）：单个干净任务直接提交、没有密钥先去设置、其余弹确认。
import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { Board } from "../core/board";
import type { ConfirmItem } from "../core/submission";
import { copyTextDone, copyTextFailed, decideRegenerate, decideRun, NEED_KEY_TEXT, regenerateConfirmText } from "./appRun";

const board = (): Board => ({ format_version: 2, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} });

const item = (patch: Partial<ConfirmItem> = {}): ConfirmItem =>
  ({ taskId: "t1", modelName: "m", firstLine: "生成 1 张", send: null, reasons: [], warnings: [], ...patch }) as ConfirmItem;

describe("运行的判定", () => {
  it("没有可提交的任务：只给一句话", () => {
    const decision = decideRun([], 0, true);
    expect(decision.kind).toBe("toast");
    if (decision.kind === "toast") expect(decision.message).toBe("没有需要运行的任务");
  });

  it("单个标红的任务：只给一句话", () => {
    const decision = decideRun([item({ reasons: [{ text: "缺图", category: "notReady", kind: "positiveMissing" }] })], 0, true);
    expect(decision.kind).toBe("toast");
    if (decision.kind === "toast") expect(decision.message).toContain("缺图");
  });

  it("没有密钥：先去高级设置填", () => {
    expect(decideRun([item()], 0, false)).toEqual({ kind: "needKey" });
  });

  it("单个干净任务：直接提交", () => {
    const decision = decideRun([item()], 0, true);
    if (decision.kind === "submit") expect(decision.taskId).toBe("t1");
    else expect(decision.kind).toBe("confirm");
  });

  it("单个有警告的任务：弹确认", () => {
    expect(decideRun([item({ warnings: ["会花钱"] })], 0, true).kind).toBe("confirm");
  });

  it("多个任务：弹确认，并带上范围", () => {
    const decision = decideRun([item(), item({ taskId: "t2" })], 2, true);
    expect(decision.kind).toBe("confirm");
    if (decision.kind === "confirm") expect(decision.scope).toBe("selection");
  });

  it("没有选中：范围是整板", () => {
    const decision = decideRun([item(), item({ taskId: "t2" })], 0, true);
    if (decision.kind === "confirm") expect(decision.scope).toBe("board");
  });
});

describe("重新生成的判定", () => {
  it("确认文案：给份数、模型与提醒", () => {
    expect(regenerateConfirmText(3, "Flash", "注意费用")).toBe("将生成 3 份，模型 Flash。\n注意费用。");
    expect(regenerateConfirmText(3, "Flash", null)).toBe("将生成 3 份，模型 Flash。");
  });

  it("生成变体：固定一份，不确认", () => {
    expect(decideRegenerate(board(), BUILTIN_TABLE, "t1", 2, "parent")).toEqual({ kind: "regenerate", copies: 1 });
  });
});

describe("复制发送文本", () => {
  it("成功与失败的提示", () => {
    expect(copyTextDone).toBe("已复制发送文本");
    expect(copyTextFailed("offline")).toBe("复制失败：offline");
  });

  it("没有密钥时的提示", () => {
    expect(NEED_KEY_TEXT).toContain("API 密钥");
  });
});
