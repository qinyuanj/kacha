// @vitest-environment jsdom
// 界面经壳端口驱动（#126）：粘贴分派、复制图片 / 节点标记、打开与新建画板、保存冲突的类型化结局、
// 导入画板包的成功 / 部分成功 / 失败。端口是内存替身（shell/testing/fakePort），不起 MyGo runtime、不发请求。
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoard, serializeBoard, type Board } from "../core/board";
import { BUILTIN_TABLE } from "../core/capabilities";
import type { BoardChange } from "../core/edit";
import type { ClipboardContent } from "../core/clipboardDispatch";
import { isNodeMarker, nodeMarker } from "../core/pageInput";
import { fakePackFile } from "../core/testing/packFixture";
import { createFakePort, type FakePort } from "../shell/testing/fakePort";
import { BOARD_MISSING_TEXT, PACK_IMPORT_TEXT, PASTE_TEXT } from "./boardText";
import { readClipboard, writeClipboard } from "./canvasKeyboard";
import { useCanvasPaste } from "./canvasPaste";
import { ShellProvider, useShell } from "./shell";
import { useBoardKeyboard } from "./useBoardKeyboard";
import { useBoardPack } from "./useBoardPack";
import { useBoardSessions } from "./useBoardSessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOARD_PATH = "/~/画板/测试.ugcboard.json";
const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null;

let nativeSnapshot: ClipboardContent | null = null;
let container: HTMLDivElement;
let root: Root;
let port: FakePort;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  port = createFakePort();
  writeClipboard(null);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  writeClipboard(null);
});

/** 渲染一棵树，壳端口注入替身。 */
async function show(ui: ReactElement): Promise<void> {
  await act(async () => root.render(createElement(ShellProvider, { port, children: ui })));
  await act(async () => {
    await Promise.resolve();
  });
}

/** 剪贴板事件替身：jsdom 的 Event 上补一个 clipboardData。 */
async function pasteEvent(clipboard: { files?: File[]; text?: string | null }): Promise<Event> {
  const files = clipboard.files ?? [];
  const images = files.filter(file => file.type.startsWith("image/") && file.size > 0);
  const text = clipboard.text ?? null;
  nativeSnapshot = { kind: isNodeMarker(text) ? "mark" : images.length ? "images" : files.length ? "unsupported" : text ? "text" : "empty", text, images, reason: files.length && !images.length ? "files" : null, readFailureCount: files.length - images.length };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files: clipboard.files ?? [], getData: (type: string) => (type === "text/plain" ? (clipboard.text ?? "") : "") },
  });
  await act(async () => { window.dispatchEvent(event); await Promise.resolve(); });
  return event;
}

const fileOf = (name: string, type: string): File => new File(["x"], name, { type });

describe("粘贴分派（端口驱动）", () => {
  const applied: BoardChange[] = [];
  const toasts: string[] = [];

  function PasteProbe({ onImages }: { onImages: (files: File[]) => void }): null {
    useCanvasPaste({
      wrapper: { current: null },
      dialogOpen: { current: false },
      modalOpen: false,
      readOnly: false,
      screenToFlowPosition: (client) => client,
      centerPosition: () => ({ x: 0, y: 0 }),
      apply: (change) => {
        applied.push(change);
      },
      toast: (message) => toasts.push(message),
      importPastedImages: onImages,
      isEditableTarget,
      readClipboard: async () => nativeSnapshot,
    });
    return null;
  }

  beforeEach(() => {
    applied.length = 0;
    toasts.length = 0;
    writeClipboard(null);
  });

  it("剪贴板里是节点标记、应用内剪贴板有内容：粘节点，不落图片", async () => {
    const images = vi.fn();
    writeClipboard({ nodes: [{ id: "p1", type: "prompt", pos: [0, 0], size: [240, 120], text: "p1", extra: {} }], edges: [] });
    await show(createElement(PasteProbe, { onImages: images }));
    expect((await pasteEvent({ text: nodeMarker(1) })).defaultPrevented).toBe(true);
    expect(applied).toEqual([expect.objectContaining({ kind: "paste" })]);
    expect(images).not.toHaveBeenCalled();
  });

  it("剪贴板里是图片：交给图片导入（落成参考图节点）", async () => {
    const images = vi.fn();
    await show(createElement(PasteProbe, { onImages: images }));
    expect((await pasteEvent({ files: [fileOf("shot.png", "image/png")] })).defaultPrevented).toBe(true);
    expect(images).toHaveBeenCalledWith([expect.objectContaining({ name: "shot.png" })], { x: 0, y: 0 });
    expect(applied).toEqual([]);
  });

  it("两样都不是（普通文本）：放行给浏览器，不提示也不落盘", async () => {
    const images = vi.fn();
    await show(createElement(PasteProbe, { onImages: images }));
    expect((await pasteEvent({ text: "一段普通文字" })).defaultPrevented).toBe(true);
    expect(images).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it("标记还在但应用内剪贴板空了：按失效剪贴板提示重新复制", async () => {
    const images = vi.fn();
    await show(createElement(PasteProbe, { onImages: images }));
    expect((await pasteEvent({ text: nodeMarker(2) })).defaultPrevented).toBe(true);
    expect(toasts).toEqual([PASTE_TEXT.staleNodeClip]);
    expect(applied).toEqual([]);
  });
});

describe("复制（端口驱动）", () => {
  const toasts: string[] = [];
  const reference = { id: "r1", type: "reference" as const, pos: [0, 0] as [number, number], size: [200, 220] as [number, number], extra: {}, path: "reference/r1.png", sha256: "a".repeat(64), display_name: "r1.png" };
  const board: Board = { ...newBoard("画板"), nodes: [reference] };

  function KeyboardProbe({ current, selected }: { current: Board; selected: string[] }): null {
    useBoardKeyboard({
      wrapper: { current: document.body as HTMLDivElement },
      boardRef: { current },
      selectedRef: { current: new Set(selected) },
      dialogOpen: { current: false },
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      toast: (message) => toasts.push(message),
      port,
    });
    return null;
  }

  const pressCopy = async (): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await act(async () => {
      await Promise.resolve();
    });
    return event;
  };

  beforeEach(() => {
    toasts.length = 0;
    writeClipboard(null);
  });

  it("单选一张图片节点：经端口把图片写进系统剪贴板，不写节点标记", async () => {
    await show(createElement(KeyboardProbe, { current: board, selected: ["r1"] }));
    const event = await pressCopy();
    expect(event.defaultPrevented).toBe(true);
    expect(port.calls.copyImage).toEqual([{ path: "/~/reference/r1.png", format: "png" }]);
    expect(port.calls.copyText).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("复制图片失败（端口给的 decode 结局）：提示并指向另存为", async () => {
    port = createFakePort({ copyImage: { ok: false, reason: "decode" } });
    await show(createElement(KeyboardProbe, { current: board, selected: ["r1"] }));
    await pressCopy();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("复制图片失败");
  });

  it("多选节点：写应用内剪贴板与系统剪贴板里的节点标记，不复制图片", async () => {
    const multi: Board = { ...newBoard("画板"), nodes: [reference, { id: "p1", type: "prompt", pos: [0, 0], size: [240, 120], text: "p1", extra: {} }] };
    await show(createElement(KeyboardProbe, { current: multi, selected: ["r1", "p1"] }));
    await pressCopy();
    expect(port.calls.copyImage).toEqual([]);
    expect(port.calls.copyText).toEqual([nodeMarker(2)]);
    expect(readClipboard()?.nodes.map((n) => n.id)).toEqual(["r1", "p1"]);
  });
});

describe("打开 / 新建画板（端口驱动）", () => {
  function SessionsProbe({ onReady }: { onReady: (s: ReturnType<typeof useBoardSessions>) => void }): null {
    const sessions = useBoardSessions(useShell().userRoot, () => ({ table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set() }));
    onReady(sessions);
    return null;
  }

  const mount = async (): Promise<ReturnType<typeof useBoardSessions>> => {
    let sessions!: ReturnType<typeof useBoardSessions>;
    await show(createElement(SessionsProbe, { onReady: (s) => (sessions = s) }));
    return sessions;
  };

  it("打开画板：经端口读原文，标签页拿到内容与版本", async () => {
    port = createFakePort({ boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("测试")), version: "v1" }] });
    const sessions = await mount();
    await act(async () => {
      expect(await sessions.openPath(BOARD_PATH)).toBe(true);
    });
    expect(port.calls.read).toEqual([BOARD_PATH]);
    expect(sessions.snapshot().sessions[0]).toMatchObject({ status: "ok", version: "v1" });
  });

  it("新建画板：只新建不覆盖地写，文件名按端口列表去重", async () => {
    port = createFakePort({ boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("测试")), version: "v1" }] });
    const sessions = await mount();
    await act(async () => {
      expect(await sessions.createBoard()).toBeNull();
    });
    expect(port.calls.write).toHaveLength(1);
    expect(port.calls.write[0].options).toEqual({ createOnly: true });
    expect(port.calls.write[0].path).not.toBe(BOARD_PATH);
  });

  it("保存冲突：端口给 conflict，标签页记成冲突并保留本页改动", async () => {
    vi.useFakeTimers();
    try {
      port = createFakePort({
        boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("测试")), version: "v1" }],
        writeFailures: new Map([[BOARD_PATH, "conflict"]]),
      });
      const sessions = await mount();
      await act(async () => {
        await sessions.openPath(BOARD_PATH);
      });
      const key = sessions.snapshot().sessions[0].key;
      await act(async () => {
        sessions.apply(key, { kind: "title", title: "新标题" });
        await sessions.flushNow(key);
      });
      const session = sessions.snapshot().sessions[0];
      expect(session).toMatchObject({ status: "ok", conflicted: true });
      expect(session.status === "ok" && session.board.title).toBe("新标题");
      expect(port.calls.log.some((l) => l.kind === "board_save_failed")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("画板已不存在：端口给 missing，保存失败提示可导出画板包", async () => {
    vi.useFakeTimers();
    try {
      port = createFakePort({
        boards: [{ path: BOARD_PATH, main: serializeBoard(newBoard("测试")), version: "v1" }],
        writeFailures: new Map([[BOARD_PATH, "missing"]]),
      });
      const sessions = await mount();
      await act(async () => {
        await sessions.openPath(BOARD_PATH);
      });
      const key = sessions.snapshot().sessions[0].key;
      await act(async () => {
        sessions.apply(key, { kind: "title", title: "新标题" });
        await sessions.flushNow(key);
      });
      const session = sessions.snapshot().sessions[0];
      expect(session.status === "ok" && session.missing).toBe(true);
      expect(session.status === "ok" && session.saveError).toContain(BOARD_MISSING_TEXT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("导入画板包（端口驱动）", () => {
  const toasts: string[] = [];
  const opened: string[] = [];
  let pack!: ReturnType<typeof useBoardPack>;

  function PackProbe(): null {
    pack = useBoardPack(port.userRoot, {
      flushAll: async () => undefined,
      getBoard: () => null,
      boardFileName: () => null,
      openImportedBoard: async (path) => {
        opened.push(path);
      },
    }, (message) => toasts.push(message));
    return null;
  }

  const runImport = async (): Promise<void> => {
    await show(createElement(PackProbe));
    await act(async () => {
      await pack.importPack();
    });
  };

  beforeEach(() => {
    toasts.length = 0;
    opened.length = 0;
  });

  it("成功：端口的 done 结局原样交给界面，打开导入的画板并提示", async () => {
    const file = fakePackFile();
    port = createFakePort({
      pickPackFiles: [file],
      imports: [{ kind: "done", summary: { imported: 2, skipped: 0, conflicts: [], message: "已导入 2 个任务目录、1 块画板" }, written: ["/~/画板/新.ugcboard.json"] }],
    });
    await runImport();
    expect(port.calls.import).toHaveLength(1);
    expect(port.calls.import[0].file).toBe(file);
    expect(opened).toEqual(["/~/画板/新.ugcboard.json"]);
    expect(toasts).toEqual(["已导入 2 个任务目录、1 块画板"]);
    expect(pack.dialog).toBeNull();
  });

  it("部分成功：冲突清单进对话框，提示仍是端口的结论文案", async () => {
    port = createFakePort({
      pickPackFiles: [fakePackFile()],
      imports: [{ kind: "partial", message: "已导入 1 个任务目录，1 个冲突", conflicts: ["2026-01-01/t1"] }],
    });
    await runImport();
    expect(pack.dialog?.state).toMatchObject({ stage: "importDone", message: "已导入 1 个任务目录，1 个冲突", conflicts: ["2026-01-01/t1"] });
    expect(toasts).toEqual([]);
  });

  it("失败：端口的失败结局按文案提示，不打开任何画板", async () => {
    port = createFakePort({ pickPackFiles: [fakePackFile()], imports: [{ kind: "failed", error: "磁盘写满" }] });
    await runImport();
    expect(pack.dialog?.state).toMatchObject({ stage: "importDone", notice: PACK_IMPORT_TEXT.commitFailed });
    expect(opened).toEqual([]);
  });

  it("画板位满：提示端口给的那句话，不进入导入", async () => {
    port = createFakePort({ pickPackFiles: [fakePackFile()], imports: [{ kind: "slotsFull", message: "画板位已满（10/10）" }] });
    await runImport();
    expect(toasts).toEqual(["画板位已满（10/10）"]);
    expect(pack.dialog).toBeNull();
  });

  it("取消选包：什么都不做", async () => {
    port = createFakePort({ pickPackFiles: [null] });
    await runImport();
    expect(port.calls.import).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
