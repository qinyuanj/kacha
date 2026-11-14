// @vitest-environment jsdom
// 工作台的提示条（#137）：保存失败、体量提醒、归档与备份提示。
import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Board } from "../core/board";
import { ArchivedBar, BackupHint, SaveFailureBar, SizeNoticeBar, UsageLimitBar } from "./appBars";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let dom: ReactRoot;

const board = { title: "a", format_version: 2, viewport: { zoom: 1, x: 0, y: 0 }, nodes: [], edges: [], extra: {} } as unknown as Board;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  dom = createRoot(container);
});

afterEach(async () => {
  await act(async () => dom.unmount());
  container.remove();
});

describe("提示条", () => {
  it("保存失败：给出动作", async () => {
    await act(async () =>
      dom.render(
        createElement(SaveFailureBar, {
          board,
          saveError: "写不进去",
          missing: false,
          conflicted: false,
          onReload: () => undefined,
          onRetry: () => undefined,
          onExport: () => undefined,
          onClose: () => undefined,
        }),
      ),
    );
    expect(container.textContent).toContain("写不进去");
    expect(container.textContent).toContain("重试保存");
    expect(container.textContent).toContain("导出画板包");
  });

  it("保存冲突：给重新载入", async () => {
    await act(async () =>
      dom.render(
        createElement(SaveFailureBar, {
          board,
          saveError: "画板已在别处修改",
          missing: false,
          conflicted: true,
          onReload: () => undefined,
          onRetry: () => undefined,
          onExport: () => undefined,
          onClose: () => undefined,
        }),
      ),
    );
    expect(container.textContent).toContain("重新载入");
  });

  it("体量提醒：给出整理入口", async () => {
    await act(async () => dom.render(createElement(SizeNoticeBar, { bytes: 2 * 1024 * 1024, tier: "alert", canTidy: true, onTidy: () => undefined, onDismiss: () => undefined })));
    expect(container.textContent).toContain("整理");
  });

  it("用量提醒：给出管理画板入口", async () => {
    await act(async () => dom.render(createElement(UsageLimitBar, { level: "alert", total: 200, limit: 100, onManage: () => undefined, onDismiss: () => undefined })));
    expect(container.textContent).toContain("用量");
  });

  it("归档提示：给出取消归档与复制", async () => {
    await act(async () => dom.render(createElement(ArchivedBar, { onUnarchive: () => undefined, onCopy: () => undefined })));
    expect(container.textContent).toContain("归档");
  });

  it("备份提示：一直显示", async () => {
    await act(async () => dom.render(createElement(BackupHint, {})));
    expect(container.textContent).toContain("导出");
  });
});
