// 画板包菜单（#127）：桌面壳本切片没有画板包导出与生成，入口标「尚不可用」并置灰；Web 版照旧。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "../shell/desktop";
import { createFakePort } from "../shell/testing/fakePort";
import { packMenuEntries } from "./packMenuEntries";

const INFO: DesktopInfo = {
  version: "0.1.0",
  user_data_root: "C:/Kacha/data",
  board_root: "C:/Kacha/data/画板",
  features: { generation: false, usage: false, pack_export: false },
};

function fakeBridge(): DesktopBridge {
  const local = new Proxy({} as DesktopLocalBridge, {
    get: () => () => Promise.reject(new Error("没实现的本地调用")),
  });
  return { info: () => Promise.resolve(INFO), local };
}

describe("画板包菜单", () => {
  it("桌面壳：导出与导入画板包标「尚不可用」并置灰", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    const entries = packMenuEntries(port, true);
    const exportEntry = entries.find((e) => e.label.startsWith("导出画板包"));
    expect(exportEntry?.label).toContain("尚不可用");
    expect(exportEntry?.disabledReason).not.toBeNull();
    const importEntry = entries.find((e) => e.label.startsWith("导入画板包"));
    expect(importEntry?.label).toContain("尚不可用");
    expect(importEntry?.disabledReason).not.toBeNull();
  });

  it("桌面壳：下载整板结果标「尚不可用」并置灰", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    const entry = packMenuEntries(port, true).find((e) => e.label.startsWith("下载整板结果"));
    expect(entry?.label).toContain("尚不可用");
    expect(entry?.disabledReason).not.toBeNull();
  });

  it("Web 版：入口照旧可用", () => {
    const port = createFakePort();
    const entries = packMenuEntries(port, true);
    for (const entry of entries) {
      expect(entry.label).not.toContain("尚不可用");
      expect(entry.disabledReason).toBeNull();
    }
  });
});
