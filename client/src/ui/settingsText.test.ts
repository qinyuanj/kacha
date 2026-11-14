// 高级设置文件状态的文案（#137）：ok 时没有提示，其余各给一句。
import { describe, expect, it } from "vitest";
import { SETTINGS_UNREADABLE_TEXT, settingsFileProblem, settingsNewerText } from "./settingsText";

describe("设置文件状态的文案", () => {
  it("ok：没有提示", () => {
    expect(settingsFileProblem("ok")).toBeNull();
  });

  it("newer：说明由更新版本写入", () => {
    expect(settingsFileProblem("newer", 2)).toBe(settingsNewerText(2));
  });

  it("corrupt：说明已损坏并给出原因", () => {
    expect(settingsFileProblem("corrupt", undefined, "不是有效的 JSON")).toContain("不是有效的 JSON");
    expect(settingsFileProblem("corrupt", undefined, "不是有效的 JSON")).toContain("本次使用默认设置");
  });

  it("unreadable：说明读不到", () => {
    expect(settingsFileProblem("unreadable")).toBe(SETTINGS_UNREADABLE_TEXT);
  });
});
