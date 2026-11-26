// 画板包菜单（#127）：桌面壳本切片没有画板包导出，入口标「尚不可用」并置灰。
// 导入画板包不需要打开的画板：具备导入能力时始终可用。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "../shell/desktop";
import { createFakePort } from "../shell/testing/fakePort";
import { UNAVAILABLE_TEXT } from "../core/uiText";
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
  it("桌面壳：导出画板包标「尚不可用」并置灰", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    const entries = packMenuEntries(port, { open: true, broken: false });
    const exportEntry = entries.find((e) => e.label.startsWith("导出画板包"));
    expect(exportEntry?.label).toContain(UNAVAILABLE_TEXT);
    expect(exportEntry?.disabledReason).not.toBeNull();
  });

  it("桌面壳：桥上没有 Pack 服务时导入才标「尚不可用」", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    const importEntry = packMenuEntries(port, { open: true, broken: false }).find((e) => e.label.startsWith("导入画板包"));
    expect(importEntry?.label).toContain(UNAVAILABLE_TEXT);
    expect(importEntry?.disabledReason).toBe("画板包导入" + UNAVAILABLE_TEXT);
  });

  it("端口声明能力可用时：入口照旧可用", () => {
    const port = createFakePort();
    const entries = packMenuEntries(port, { open: true, broken: false });
    for (const entry of entries) {
      expect(entry.label).not.toContain(UNAVAILABLE_TEXT);
      expect(entry.disabledReason).toBeNull();
    }
  });

  it("端口声明能力可用时：导出按画板状态置灰", () => {
    const port = createFakePort();
    const reason = (board: { open: boolean; broken: boolean }, label: string) =>
      packMenuEntries(port, board).find((e) => e.label.startsWith(label))?.disabledReason;
    expect(reason({ open: false, broken: false }, "导出画板包")).toBe("没有打开的画板");
    expect(reason({ open: false, broken: true }, "导出画板包")).toBe("画板无法打开，不能导出");
    expect(reason({ open: true, broken: false }, "导出画板包")).toBeNull();
  });

});
