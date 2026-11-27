// 单一版本入口的样子（#269）：文案固定为当前安装版本，颜色与状态由阶段决定。
import { describe, expect, it } from "vitest";
import { emptySnapshot, type UpdateSnapshot } from "../core/update";
import { updateButtonView } from "./updateButtonView";

/** 按阶段造一个真实快照；候选版本与当前版本故意不同，确保按钮不切换文案。 */
const at = (phase: UpdateSnapshot["phase"], overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  ...emptySnapshot(),
  phase,
  ...overrides,
});

type Case = [UpdateSnapshot["phase"], "neutral" | "latest" | "action", string, Partial<UpdateSnapshot>?];

const cases: Case[] = [
  ["disabled", "neutral", "自动更新尚不可用"],
  ["idle", "neutral", "尚未检查更新"],
  ["checking", "neutral", "正在检查更新…"],
  ["up_to_date", "latest", "已是最新版本"],
  ["available", "action", "发现新版本 9.9.9，准备下载", { version: "9.9.9" }],
  ["downloading", "action", "正在下载 9.9.9（40%）", { version: "9.9.9", downloaded: 40, total: 100 }],
  ["ready", "action", "新版本 9.9.9 已下载并验签，可安装", { version: "9.9.9" }],
  ["installing", "action", "正在安装，安装完成后请重新启动"],
  ["error", "neutral", "检查更新失败"],
];

describe("版本入口的样子", () => {
  for (const [phase, tone, status, overrides] of cases) {
    it(phase + " 只显示当前版本，色调与状态来自更新阶段", () => {
      expect(updateButtonView(at(phase, overrides), "1.7.3", true)).toEqual({ label: "1.7.3", tone, status });
    });
  }

  it("自动更新能力关闭时仍显示当前版本且保持普通色", () => {
    expect(updateButtonView(at("available", { version: "9.9.9" }), "1.7.3", false)).toEqual({
      label: "1.7.3",
      tone: "neutral",
      status: "自动更新尚不可用",
    });
  });

  it("检查失败给出原因，但不伪装成有新版本", () => {
    expect(updateButtonView(at("error", { error: "网络不可达" }), "1.7.3", true)).toEqual({
      label: "1.7.3",
      tone: "neutral",
      status: "网络不可达",
    });
  });
});
