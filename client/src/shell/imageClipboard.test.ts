// @vitest-environment jsdom
// 图片复制适配器（#115）：成功要同时有两份证据——复制命令返回成功，且同一次操作里观察到原生 copy 事件。
// 只看命令返回值不算成功；每种退出（成功与四类失败）都要移除临时图片并恢复操作前的 DOM 选区。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyImageToClipboard, type ImageCopyFailure } from "./imageClipboard";

type DecodeMode = "ok" | "fail";
type CommandMode = "accept" | "reject" | "throw";

interface Case {
  name: string;
  decode: DecodeMode;
  command: CommandMode;
  /** 复制命令执行期间浏览器是否派发原生 copy 事件。 */
  event: boolean;
  expected: ImageCopyFailure | null;
}

const CASES: Case[] = [
  { name: "解码成功 + 命令成功 + 观察到原生 copy 事件：成功", decode: "ok", command: "accept", event: true, expected: null },
  { name: "解码成功 + 命令成功 + 没有原生 copy 事件：按失败处理", decode: "ok", command: "accept", event: false, expected: { kind: "noEvent" } },
  { name: "解码成功 + 命令被拒绝：按失败处理", decode: "ok", command: "reject", event: false, expected: { kind: "rejected" } },
  { name: "命令被拒绝但仍观察到原生 copy 事件：仍按失败处理", decode: "ok", command: "reject", event: true, expected: { kind: "rejected" } },
  { name: "解码失败：按失败处理，并且不发起复制命令", decode: "fail", command: "accept", event: true, expected: { kind: "decode" } },
  { name: "意外异常：按失败处理并带出原因", decode: "ok", command: "throw", event: true, expected: { kind: "exception", detail: "浏览器炸了" } },
];

const SRC = "/api/fs/file?path=%E5%8F%82%E8%80%83%E5%9B%BE%2Fcat.png";

let decodeMode: DecodeMode = "ok";
let commandMode: CommandMode = "accept";
/** 复制命令执行期间浏览器是否派发原生 copy 事件。 */
let fireCopyEvent = false;
/** 复制命令执行时看到的临时图片的 src：证明交给浏览器的是这张图片。 */
let seenSrc: string | null = null;
let execCommand: ReturnType<typeof vi.fn>;

beforeEach(() => {
  decodeMode = "ok";
  commandMode = "accept";
  fireCopyEvent = false;
  seenSrc = null;
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    writable: true,
    value: vi.fn(() => (decodeMode === "ok" ? Promise.resolve() : Promise.reject(new Error("解码失败")))),
  });
  execCommand = vi.fn((command: string) => {
    if (command !== "copy") return false;
    seenSrc = document.body.querySelector("img")?.getAttribute("src") ?? null;
    if (commandMode === "throw") throw new Error("浏览器炸了");
    if (fireCopyEvent) document.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
    return commandMode === "accept";
  });
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: execCommand });
});

afterEach(() => {
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

/** 选中原先的一段文字：复制图片之后应当恢复。 */
function selectParagraph(text: string): void {
  const p = document.createElement("p");
  p.textContent = text;
  document.body.append(p);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(p);
  selection.addRange(range);
}

describe("图片复制的结果判定", () => {
  it.each(CASES)("$name", async (c) => {
    decodeMode = c.decode;
    commandMode = c.command;
    fireCopyEvent = c.event;
    selectParagraph("操作前选中的文字");

    const result = await copyImageToClipboard(SRC);

    expect(result).toEqual(c.expected);
    // 交给浏览器的是这张图片本身，不是图片地址。
    if (c.decode === "fail") expect(execCommand).not.toHaveBeenCalled();
    else {
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(seenSrc).toBe(SRC);
    }
    // 临时图片元素已移除。
    expect(document.body.querySelector("img")).toBeNull();
    // 操作前的 DOM 选区已恢复。
    const selection = document.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    expect(selection.toString()).toBe("操作前选中的文字");
  });
});

describe("原生 copy 事件是否算「本次复制」的证据", () => {
  /** 复制命令执行期间派发的 copy 事件：迟一点派发也算本次操作的证据。 */
  let copyEventDelayMs = 0;
  /** 复制命令执行前，用户已经把选区换到别处（模拟同时复制了别的内容）。 */
  let selectionMovedAway = false;

  beforeEach(() => {
    copyEventDelayMs = 0;
    selectionMovedAway = false;
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: vi.fn(() => Promise.resolve()) });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: vi.fn((command: string) => {
        if (command !== "copy") return false;
        if (selectionMovedAway) {
          const other = document.createElement("p");
          other.textContent = "别处";
          document.body.append(other);
          const selection = document.getSelection()!;
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(other);
          selection.addRange(range);
        }
        setTimeout(() => document.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true })), copyEventDelayMs);
        return true;
      }),
    });
  });

  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
    delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
    document.body.innerHTML = "";
    document.getSelection()?.removeAllRanges();
  });

  it("事件晚一点才派发：仍算本次操作的证据，不误报「没观察到事件」", async () => {
    copyEventDelayMs = 20;
    expect(await copyImageToClipboard(SRC)).toBeNull();
  });

  it("选区已被换到别处：那个 copy 事件不算本次复制的证据", async () => {
    selectionMovedAway = true;
    expect(await copyImageToClipboard(SRC)).toEqual({ kind: "noEvent" });
  });
});
