// 真实 React Flow 回归夹具：生成结果落地后切到提示词，任务虽收起参数，已有输入连线仍须渲染。
import "@xyflow/react/dist/style.css";
import "../src/styles/index.css";
import { ReactFlowProvider } from "@xyflow/react";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { newBoard, type Board } from "../src/core/board";
import { BUILTIN_TABLE } from "../src/core/capabilities";
import { editBoard, type BoardChange, type EditResult } from "../src/core/edit";
import { createFakePort } from "../src/shell/testing/fakePort";
import { BoardCanvas } from "../src/ui/BoardCanvas";
import { ShellProvider } from "../src/ui/shell";

document.documentElement.dataset.theme = "light";

const initial = newBoard("连线复现");
initial.nodes = [
  { id: "p", type: "prompt", pos: [40, 40], size: [240, 140], extra: {}, text: "把图1变成美少女" },
  { id: "r", type: "reference", pos: [40, 350], size: [200, 160], extra: {}, path: "reference/cat.png", sha256: "a".repeat(64), display_name: "cat.png" },
  { id: "t", type: "task", pos: [500, 100], size: [280, 260], extra: {}, model: "doubao-seedream-5-0-pro-260628", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, image_ports: 1, layer_decomposition: false, transparent_background: false, last_submitted: null },
];
initial.edges = [
  { from: ["p", "out"], to: ["t", "positive"], source_layer: null, region: null, system: false, extra: {} },
  { from: ["r", "out"], to: ["t", "image:0"], source_layer: null, region: null, system: false, extra: {} },
];

const port = createFakePort();

function Harness() {
  const [board, setBoard] = useState<Board>(initial);
  const apply = (change: BoardChange): EditResult | null => {
    const result = editBoard(board, change, { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set(), imageSize: () => [1024, 1024], newId: () => "result-1" });
    setBoard(result.board);
    return result;
  };
  return createElement("div", null,
    createElement("button", { style: { position: "fixed", zIndex: 10000 }, onClick: () => apply({ kind: "runResult", result: {
      taskId: "t", submittedTaskId: "task-1", file: "result.png", path: "2026-11-26/task-1/result.png",
      record: { model: "doubao-seedream-5-0-pro-260628", prompt: "把图1变成美少女", negative_prompt: "", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, submitted_at: "2026-11-26T09:00:00Z" },
    } }) }, "完成生成"),
    createElement(ReactFlowProvider, null, createElement(ShellProvider, { port, children: createElement(BoardCanvas, {
      board, boardFile: "repro.json", table: BUILTIN_TABLE, userRoot: "/~", apply, check: () => null,
      locked: new Set<string>(), onUndo: () => {}, onRedo: () => {}, undoLabel: null, redoLabel: null,
      toast: () => {}, discovery: { source: "none" }, concurrency: 2, runNodes: new Map(), handled: new Set<string>(),
      onRun: () => {}, onCancelTask: () => {}, onRegenerate: () => {}, onViewSendText: () => {}, toolbarSlot: null, focus: null, theme: "light",
    }) })),
  );
}

createRoot(document.getElementById("root")!).render(createElement(Harness));
