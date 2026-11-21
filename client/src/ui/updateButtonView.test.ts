// 更新按钮的样子（#181）：文案与色调都跟着阶段走。
import { describe, expect, it } from "vitest";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { updateButtonView } from "./updateButtonView";

/** 按阶段造一个快照。 */
const at = (phase: UpdateSnapshot["phase"], overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  ...emptySnapshot(),
  phase,
  ...overrides,
});

describe("更新按钮的样子", () => {
  it("还没查：中性，文案是「检查更新」", () => {
    expect(updateButtonView(at("idle"))).toEqual({ label: "检查更新", tone: "neutral" });
  });

  it("检查中：中性，文案说明正在查", () => {
    expect(updateButtonView(at("checking"))).toEqual({ label: "检查中…", tone: "neutral" });
  });

  it("已是最新：绿色", () => {
    expect(updateButtonView(at("up_to_date"))).toEqual({ label: "已是最新", tone: "latest" });
  });

  it("有新版本：红色，文案带上版本号", () => {
    expect(updateButtonView(at("available", { version: "1.6.8" }))).toEqual({ label: "有新版本 1.6.8", tone: "action" });
  });

  it("下载中：中性，带进度", () => {
    expect(updateButtonView(at("downloading", { version: "1.6.8", downloaded: 40, total: 100 }))).toEqual({ label: "下载中（40%）", tone: "neutral" });
  });

  it("就绪可装：红色，文案说明能装了", () => {
    expect(updateButtonView(at("ready", { version: "1.6.8" }))).toEqual({ label: "新版本 1.6.8 就绪", tone: "action" });
  });

  it("安装中：中性", () => {
    expect(updateButtonView(at("installing"))).toEqual({ label: "安装中…", tone: "neutral" });
  });

  it("失败：红色，文案是「检查失败」", () => {
    expect(updateButtonView(at("error"))).toEqual({ label: "检查失败", tone: "bad" });
  });

  it("自动更新不可用：中性", () => {
    expect(updateButtonView(at("disabled"))).toEqual({ label: "自动更新尚不可用", tone: "neutral" });
  });
});
