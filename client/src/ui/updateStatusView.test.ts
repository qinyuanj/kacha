// 主界面更新提示条的可见判定（#180）：哪些阶段要露面、什么时候给「稍后」。
import { describe, expect, it } from "vitest";
import { emptySnapshot, type UpdatePhase, type UpdateSnapshot } from "../core/update";
import { IDLE_AUTO_VIEW, type AutoInstallView } from "../core/updateAutoInstall";
import { updateStatusView } from "./updateStatusView";

const snapshot = (phase: UpdatePhase): UpdateSnapshot => ({ ...emptySnapshot(), phase, version: "1.6.2" });

describe("更新提示条", () => {
  it("发现 / 下载中 / 已就绪 / 正在装：都显示", () => {
    for (const phase of ["available", "downloading", "ready", "installing"] as const) {
      expect(updateStatusView({ snapshot: snapshot(phase), auto: IDLE_AUTO_VIEW }).visible).toBe(true);
    }
  });

  it("还没检查、已是最新、不可用、失败：不在主界面打扰", () => {
    for (const phase of ["idle", "up_to_date", "disabled", "error", "checking"] as const) {
      expect(updateStatusView({ snapshot: snapshot(phase), auto: IDLE_AUTO_VIEW }).visible).toBe(false);
    }
  });

  it("只有倒计时期间才给「稍后」", () => {
    const counting: AutoInstallView = { ...IDLE_AUTO_VIEW, counting: true, seconds: 30 };
    expect(updateStatusView({ snapshot: snapshot("ready"), auto: counting }).canDefer).toBe(true);
    expect(updateStatusView({ snapshot: snapshot("ready"), auto: IDLE_AUTO_VIEW }).canDefer).toBe(false);
  });

});
