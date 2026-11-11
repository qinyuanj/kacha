// 画板快捷键的判定与应用内剪贴板：Ctrl / ⌘+Z 撤销、+Shift+Z / +Y 重做、+C 复制（连续粘贴逐次错开）。
// 粘贴不归 keydown 管（见 canvasPaste），这里锁住「Ctrl+V 什么都不做」这条。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PASTE_OFFSET, type Clip } from "../core/iterate";
import { nextPasteClip, readClipboard, shortcutCommand, writeClipboard } from "./canvasKeyboard";

function clipOf(...ids: string[]): Clip {
  return {
    nodes: ids.map((id, i) => ({ id, type: "prompt", pos: [i * 10, i * 20], size: [240, 120], text: id, extra: {} })),
    edges: [],
  };
}

/** 键盘事件替身：只带判定要读的字段（preventDefault 用替身，好断言时机）。 */
function keyEvent(overrides: { key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) {
  return { key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...overrides };
}

/** 判定上下文替身。 */
function context(overrides: { editable?: boolean; connected?: boolean; dialogOpen?: boolean; selectedCount?: number } = {}) {
  return { editable: false, connected: true, dialogOpen: false, selectedCount: 0, ...overrides };
}

describe("shortcutCommand", () => {
  const cases: {
    name: string;
    event: ReturnType<typeof keyEvent>;
    ctx: ReturnType<typeof context>;
    expected: ReturnType<typeof shortcutCommand>;
    prevented: boolean;
  }[] = [
    { name: "不带 Ctrl / ⌘ 的按键不归画板管", event: keyEvent({ ctrlKey: false }), ctx: context(), expected: null, prevented: false },
    { name: "⌘ 与 Ctrl 等效", event: keyEvent({ ctrlKey: false, metaKey: true }), ctx: context(), expected: { kind: "undo" }, prevented: true },
    { name: "带 Alt 的组合不算", event: keyEvent({ altKey: true }), ctx: context(), expected: null, prevented: false },
    { name: "焦点在输入区：交给原生撤销", event: keyEvent(), ctx: context({ editable: true }), expected: null, prevented: false },
    { name: "画布已卸载：不响应", event: keyEvent(), ctx: context({ connected: false }), expected: null, prevented: false },
    { name: "Ctrl+Z 撤销", event: keyEvent(), ctx: context(), expected: { kind: "undo" }, prevented: true },
    { name: "Ctrl+Shift+Z 重做", event: keyEvent({ shiftKey: true }), ctx: context(), expected: { kind: "redo" }, prevented: true },
    { name: "Ctrl+Y 重做", event: keyEvent({ key: "y" }), ctx: context(), expected: { kind: "redo" }, prevented: true },
    { name: "Ctrl+Shift+Y 两个都不是：不吞默认行为", event: keyEvent({ key: "y", shiftKey: true }), ctx: context(), expected: null, prevented: false },
    { name: "大写按键照旧", event: keyEvent({ key: "Z" }), ctx: context(), expected: { kind: "undo" }, prevented: true },
    { name: "弹窗开着也吞掉原生撤销，但不作用于背后的画板", event: keyEvent(), ctx: context({ dialogOpen: true }), expected: null, prevented: true },
    { name: "弹窗开着时重做同样只吞不作用", event: keyEvent({ shiftKey: true }), ctx: context({ dialogOpen: true }), expected: null, prevented: true },
    { name: "弹窗开着时不复制", event: keyEvent({ key: "c" }), ctx: context({ dialogOpen: true, selectedCount: 1 }), expected: null, prevented: false },
    { name: "带 Shift 的 C 不处理", event: keyEvent({ key: "c", shiftKey: true }), ctx: context({ selectedCount: 1 }), expected: null, prevented: false },
    // 判定的产物只是「该复制了」：拦不拦原生复制由执行方按实际复制结果决定（#96）。
    { name: "Ctrl+C 有选区：给 copy，自己不动默认行为", event: keyEvent({ key: "c" }), ctx: context({ selectedCount: 2 }), expected: { kind: "copy" }, prevented: false },
    { name: "选区为空时 Ctrl+C 不处理", event: keyEvent({ key: "c" }), ctx: context(), expected: null, prevented: false },
    // 粘贴不在键盘事件里做：拦默认行为会把 paste 事件一起压掉（#96）。
    { name: "Ctrl+V 完全不归 keydown 管", event: keyEvent({ key: "v" }), ctx: context({ selectedCount: 1 }), expected: null, prevented: false },
    { name: "Ctrl+Shift+V 同样不处理", event: keyEvent({ key: "v", shiftKey: true }), ctx: context(), expected: null, prevented: false },
    { name: "其它 Ctrl 组合放行", event: keyEvent({ key: "s" }), ctx: context(), expected: null, prevented: false },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const command = shortcutCommand(c.event, c.ctx);
      expect(command).toEqual(c.expected);
      expect(c.event.preventDefault).toHaveBeenCalledTimes(c.prevented ? 1 : 0);
    });
  }
});

describe("应用内剪贴板", () => {
  beforeEach(() => writeClipboard(null));

  it("还没复制过是空的；写入后可读，可清空", () => {
    expect(readClipboard()).toBeNull();
    const clip = clipOf("a", "b");
    writeClipboard(clip);
    expect(readClipboard()).toBe(clip);
    writeClipboard(null);
    expect(readClipboard()).toBeNull();
  });

  it("连续粘贴逐次错开 PASTE_OFFSET，原快照不动", () => {
    const clip = clipOf("a", "b");
    const once = nextPasteClip(clip);
    const twice = nextPasteClip(once);
    expect(once.nodes.map((n) => n.pos)).toEqual([
      [PASTE_OFFSET, PASTE_OFFSET],
      [10 + PASTE_OFFSET, 20 + PASTE_OFFSET],
    ]);
    expect(twice.nodes.map((n) => n.pos)).toEqual([
      [2 * PASTE_OFFSET, 2 * PASTE_OFFSET],
      [10 + 2 * PASTE_OFFSET, 20 + 2 * PASTE_OFFSET],
    ]);
    // 节点 id 与连线保持不变：偏移只影响位置。
    expect(twice.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(twice.edges).toEqual(clip.edges);
    expect(clip.nodes[0].pos).toEqual([0, 0]);
  });
});
