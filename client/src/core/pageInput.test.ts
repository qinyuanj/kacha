import { describe, expect, it } from "vitest";
import { BLOCKED_MOD_KEYS, blocksFileDrag, blocksKey, blocksMouseButton, type KeyShape } from "./pageInput";

const key = (patch: Partial<KeyShape>): KeyShape => ({
  key: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  editable: false,
  ...patch,
});

describe("页面级快捷键接管", () => {
  it("被拦的 Ctrl 组合是一份可枚举的清单：S / P / F / O", () => {
    // 期望值照票 #97 手写一份，不复用 BLOCKED_MOD_KEYS 的构造过程：否则改清单时测试跟着一起改，等于没测。
    expect([...BLOCKED_MOD_KEYS].sort()).toEqual(["f", "o", "p", "s"]);
  });

  it("Ctrl / Cmd + S / P / F / O 一律吞掉：保存、打印、页内查找、打开文件", () => {
    for (const letter of BLOCKED_MOD_KEYS) {
      expect(blocksKey(key({ key: letter, ctrlKey: true }))).toBe(true);
      expect(blocksKey(key({ key: letter, metaKey: true }))).toBe(true);
      // 大写字母来自 Shift 组合，同样吞（Ctrl+Shift+S 是另存网页）。
      expect(blocksKey(key({ key: letter.toUpperCase(), ctrlKey: true }))).toBe(true);
    }
  });

  it("输入框里 Ctrl+S 仍吞：这些组合在文本编辑里没有原生意义", () => {
    expect(blocksKey(key({ key: "s", ctrlKey: true, editable: true }))).toBe(true);
    expect(blocksKey(key({ key: "f", ctrlKey: true, editable: true }))).toBe(true);
  });

  it("输入框里 Ctrl+A / C / V / X / Z 放行：编辑类快捷键不受影响", () => {
    for (const letter of ["a", "c", "v", "x", "z"]) {
      expect(blocksKey(key({ key: letter, ctrlKey: true, editable: true }))).toBe(false);
    }
  });

  it("Ctrl+G / Ctrl+U 不拦：查找下一个与查看源代码保持浏览器原生", () => {
    expect(blocksKey(key({ key: "g", ctrlKey: true }))).toBe(false);
    expect(blocksKey(key({ key: "u", ctrlKey: true }))).toBe(false);
  });

  it("浏览器自己处理的 Ctrl+W / T / N 不尝试拦（只记录在已知限制里）", () => {
    for (const letter of ["w", "t", "n"]) {
      expect(blocksKey(key({ key: letter, ctrlKey: true }))).toBe(false);
    }
  });

  it("Alt+← / Alt+→ 吞掉：不后退、不前进，画板状态不丢", () => {
    expect(blocksKey(key({ key: "ArrowLeft", altKey: true }))).toBe(true);
    expect(blocksKey(key({ key: "ArrowRight", altKey: true }))).toBe(true);
    expect(blocksKey(key({ key: "ArrowLeft", altKey: true, editable: true }))).toBe(true);
    // 其余 Alt 组合与画板无关，不碰。
    expect(blocksKey(key({ key: "1", altKey: true }))).toBe(false);
    expect(blocksKey(key({ key: "Enter", altKey: true }))).toBe(false);
  });

  it("没有选中节点时方向键不再滚页：非输入区一律吞掉", () => {
    for (const arrow of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(blocksKey(key({ key: arrow }))).toBe(true);
      expect(blocksKey(key({ key: arrow }))).toBe(true);
    }
  });

  it("输入区里的方向键放行：移动光标是原生行为", () => {
    for (const arrow of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(blocksKey(key({ key: arrow, editable: true }))).toBe(false);
    }
  });

  it("其余按键放行：普通输入、Esc、Delete、翻页键交回浏览器", () => {
    for (const other of ["a", "Escape", "Delete", "Backspace", "PageDown", "Home", " "]) {
      expect(blocksKey(key({ key: other }))).toBe(false);
    }
  });
});

describe("页面级拖放接管", () => {
  const drag = (types: string[]) => ({ types });

  it("带文件的拖拽一律拦下：否则浏览器会打开文件、把应用顶掉", () => {
    expect(blocksFileDrag(drag(["Files"]))).toBe(true);
    expect(blocksFileDrag(drag(["Files", "text/plain"]))).toBe(true);
  });

  it("纯文本 / 链接拖拽放行：输入框里拖字不受影响", () => {
    expect(blocksFileDrag(drag(["text/plain"]))).toBe(false);
    expect(blocksFileDrag(drag(["text/uri-list", "text/plain"]))).toBe(false);
    expect(blocksFileDrag(drag([]))).toBe(false);
  });

  it("没有 dataTransfer 的合成事件当作不带文件", () => {
    expect(blocksFileDrag(null)).toBe(false);
  });
});

describe("页面级鼠标接管", () => {
  it("中键按下吞掉默认行为：不启动自动滚动，画布的中键平移不受影响", () => {
    expect(blocksMouseButton("down", 1)).toBe(true);
  });

  it("左键与右键按下放行：选取、上下文菜单与拖动都靠它们", () => {
    expect(blocksMouseButton("down", 0)).toBe(false);
    expect(blocksMouseButton("down", 2)).toBe(false);
  });

  it("侧键在松开时吞掉：Chromium 只认 up 上的拦截，后退 / 前进不再丢掉当前画板", () => {
    expect(blocksMouseButton("up", 3)).toBe(true);
    expect(blocksMouseButton("up", 4)).toBe(true);
  });

  it("侧键在按下时不拦：实测 down / auxclick 上 preventDefault 拦不住，白费力气", () => {
    expect(blocksMouseButton("down", 3)).toBe(false);
    expect(blocksMouseButton("down", 4)).toBe(false);
  });

  it("中键松开与左右键松开都不碰", () => {
    for (const button of [0, 1, 2]) expect(blocksMouseButton("up", button)).toBe(false);
  });
});
