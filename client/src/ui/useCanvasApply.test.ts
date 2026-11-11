// @vitest-environment jsdom
// 画板变更入口：只读拒绝（视口除外）、被拒原因提示、建议选中照选。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoard } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { ARCHIVE_TEXT } from "./boardText";
import { useCanvasApply, type ApplyChange } from "./useCanvasApply";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let apply: ApplyChange;
let setSelectedNodes: ReturnType<typeof vi.fn>;
let setSelectedEdges: ReturnType<typeof vi.fn>;

interface ProbeProps {
  applyChange: (change: BoardChange) => EditResult | null;
  toast: (message: string) => void;
  readOnly: boolean;
}

function Probe({ applyChange, toast, readOnly }: ProbeProps) {
  apply = useCanvasApply({
    applyChange,
    toast,
    readOnly,
    setSelectedNodes: setSelectedNodes as never,
    setSelectedEdges: setSelectedEdges as never,
  });
  return null;
}

async function show(props: ProbeProps): Promise<void> {
  await act(async () => root.render(createElement(Probe, props)));
}

const viewport: BoardChange = { kind: "viewport", viewport: { x: 1, y: 2, zoom: 1 } };
const removed: BoardChange = { kind: "delete", nodes: ["a"], edges: [], cancelled: [] };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  setSelectedNodes = vi.fn();
  setSelectedEdges = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("画板变更入口", () => {
  it("只读画板：视口移动静默拒绝，其余编辑提示只读", async () => {
    const applyChange = vi.fn(() => null);
    const toast = vi.fn();
    await show({ applyChange, toast, readOnly: true });

    expect(apply(viewport)).toBeNull();
    expect(toast).not.toHaveBeenCalled();

    expect(apply(removed)).toBeNull();
    expect(toast).toHaveBeenCalledWith(ARCHIVE_TEXT.readOnly);
    expect(applyChange).not.toHaveBeenCalled();
  });

  it("写入成功：有提示就提示，有建议选中就照选（连线选区清空）", async () => {
    const result: EditResult = { board: newBoard("画板"), step: { label: "删除节点" }, hint: "已删除", selection: ["p1"] };
    const applyChange = vi.fn(() => result);
    const toast = vi.fn();
    await show({ applyChange, toast, readOnly: false });

    expect(apply(removed)).toBe(result);
    expect(applyChange).toHaveBeenCalledWith(removed);
    expect(toast).toHaveBeenCalledWith("已删除");
    expect(setSelectedNodes).toHaveBeenCalledWith(new Set(["p1"]));
    expect(setSelectedEdges).toHaveBeenCalledWith(new Set());
  });

  it("写入无话可说：不提示、不动选区", async () => {
    const result: EditResult = { board: newBoard("画板"), step: null };
    const applyChange = vi.fn(() => result);
    const toast = vi.fn();
    await show({ applyChange, toast, readOnly: false });

    expect(apply(viewport)).toBe(result);
    expect(toast).not.toHaveBeenCalled();
    expect(setSelectedNodes).not.toHaveBeenCalled();
    expect(setSelectedEdges).not.toHaveBeenCalled();
  });

  it("写入被拒（返回 null）时什么都不做", async () => {
    const applyChange = vi.fn(() => null);
    const toast = vi.fn();
    await show({ applyChange, toast, readOnly: false });

    expect(apply(removed)).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
