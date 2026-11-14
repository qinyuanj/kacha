// 画板包菜单（#127）：桌面壳本切片没有画板包导出与生成，入口标「尚不可用」并置灰；Web 版照旧。
// 导入画板包不需要打开的画板：Web 版里它始终可用。
import { describe, expect, it } from "vitest";

import { createDesktopPort, type DesktopBridge, type DesktopInfo, type DesktopLocalBridge } from "../shell/desktop";
import { createFakePort } from "../shell/testing/fakePort";
import { UNAVAILABLE_TEXT } from "../core/uiText";
import { packExportEntry, packImportEntry, packMenuEntries } from "./packMenuEntries";

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

  it("桌面壳：下载整板结果标「尚不可用」并置灰", async () => {
    const { port } = await createDesktopPort(fakeBridge());
    const entry = packMenuEntries(port, { open: true, broken: false }).find((e) => e.label.startsWith("下载整板结果"));
    expect(entry?.label).toContain(UNAVAILABLE_TEXT);
    expect(entry?.disabledReason).not.toBeNull();
  });

  it("Web 版：入口照旧可用", () => {
    const port = createFakePort();
    const entries = packMenuEntries(port, { open: true, broken: false });
    for (const entry of entries) {
      expect(entry.label).not.toContain(UNAVAILABLE_TEXT);
      expect(entry.disabledReason).toBeNull();
    }
  });

  it("Web 版：导入画板包不需要打开的画板，没有画板时仍可用", () => {
    const port = createFakePort();
    for (const board of [{ open: false, broken: false }, { open: false, broken: true }]) {
      const entry = packImportEntry(port);
      expect(entry.label).toBe("导入画板包…");
      expect(entry.disabledReason).toBeNull();
      void board;
    }
  });

  it("Web 版：导出与下载仍按画板状态置灰", () => {
    const port = createFakePort();
    expect(packExportEntry(port, { open: false, broken: false }).disabledReason).toBe("没有打开的画板");
    expect(packExportEntry(port, { open: false, broken: true }).disabledReason).toBe("画板无法打开，不能导出");
    expect(packExportEntry(port, { open: true, broken: false }).disabledReason).toBeNull();
  });

});
