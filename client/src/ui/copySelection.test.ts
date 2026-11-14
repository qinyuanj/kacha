// 复制分派（#130）：Ctrl+C 的语义只看选区——恰好单选一张图就复制图片，其余选区仍复制节点标记。
// 纯逻辑：不碰 DOM、不起 MyGo runtime，真正的写入由壳端口的 media.copyImage 负责。
import { describe, expect, it } from "vitest";
import { newBoard, type Board } from "../core/board";
import { copyOutcome, imageFormatOf } from "./copySelection";

const reference = (id: string, path: string) =>
  ({ id, type: "reference" as const, pos: [0, 0] as [number, number], size: [200, 200] as [number, number], extra: {}, path, sha256: "a".repeat(64), display_name: "cat.png" });
const result = (id: string, path: string) =>
  ({
    id,
    type: "result" as const,
    pos: [0, 0] as [number, number],
    size: [200, 200] as [number, number],
    extra: {},
    task_id: "t1",
    file: "result.png",
    path,
    layer_count: 1,
    record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: null, ratio: null, width: null, height: null }, submitted_at: "2026-11-11T00:00:00Z", layers: [] },
  });
const prompt = (id: string) =>
  ({ id, type: "prompt" as const, pos: [0, 0] as [number, number], size: [240, 120] as [number, number], extra: {}, text: id });
const task = (id: string) =>
  ({
    id,
    type: "task" as const,
    pos: [0, 0] as [number, number],
    size: [280, 260] as [number, number],
    extra: {},
    model: "m",
    size_spec: { tier: null, ratio: null, width: null, height: null },
    image_ports: 1,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
  });

const board = (...nodes: Board["nodes"]): Board => ({ ...newBoard("画板"), nodes });

describe("复制分派：单选一张图才复制图片", () => {
  it("单选参考图节点：复制这张图，路径原样交给端口", () => {
    expect(copyOutcome(board(reference("r1", "参考/cat.png")), ["r1"])).toEqual({ kind: "image", path: "参考/cat.png", format: "png" });
  });

  it("单选结果节点：复制底图，不复制图层或节点", () => {
    expect(copyOutcome(board(result("res1", "任务/t1/result.png")), ["res1"])).toEqual({ kind: "image", path: "任务/t1/result.png", format: "png" });
  });

  it("JPEG / WebP 的结果节点：格式提示跟着扩展名走", () => {
    expect(copyOutcome(board(result("res1", "任务/t1/result.jpg")), ["res1"])).toMatchObject({ format: "jpeg" });
    expect(copyOutcome(board(result("res1", "任务/t1/result.webp")), ["res1"])).toMatchObject({ format: "webp" });
  });

  it("用户数据根外的绝对路径原样交给端口", () => {
    expect(copyOutcome(board(reference("r1", "D:/别处/cat.png")), ["r1"])).toMatchObject({ path: "D:/别处/cat.png" });
  });

  it("多选即使含图片：仍复制节点，画板内复制粘贴手感不变", () => {
    expect(copyOutcome(board(reference("r1", "参考/cat.png"), prompt("p1")), ["r1", "p1"])).toEqual({ kind: "nodes" });
  });

  it("提示词、任务、已不在画板上的 id：都复制节点，不复制图片", () => {
    const b = board(prompt("p1"), task("t1"));
    for (const ids of [["p1"], ["t1"], ["gone"]]) expect(copyOutcome(b, ids)).toEqual({ kind: "nodes" });
  });

  it("空选区：什么都不做（键盘只在有选区时才会走到这里）", () => {
    expect(copyOutcome(board(reference("r1", "参考/cat.png")), [])).toEqual({ kind: "nothing" });
  });
});

describe("格式提示", () => {
  it("按扩展名给提示；认不出的扩展名留空，交给 Go 按字节判断", () => {
    expect(imageFormatOf("参考/a.PNG")).toBe("png");
    expect(imageFormatOf("参考/a.jpeg")).toBe("jpeg");
    expect(imageFormatOf("参考/a.jpg")).toBe("jpeg");
    expect(imageFormatOf("参考/a.webp")).toBe("webp");
    expect(imageFormatOf("参考/a.gif")).toBe("gif");
    expect(imageFormatOf("参考/没有扩展名")).toBe("");
  });
});
