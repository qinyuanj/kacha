import { describe, expect, it } from "vitest";
import { newBoard } from "./board";
import { BLOCKED_MOD_KEYS, blocksFileDrag, blocksKey, blocksMouseButton, copyTarget, isNodeMarker, MAX_PASTE_BYTES, NODE_MARKER_PREFIX, nodeMarker, PASTE_NAME_PREFIX, pasteDisplayNames, type KeyShape } from "./pageInput";

// ---- 复制 / 粘贴分派（#98 / #96） ----
describe("节点标记", () => {
  it("编码：前缀接节点数", () => {
    expect(NODE_MARKER_PREFIX).toBe("kacha:clip:v1:");
    expect(nodeMarker(1)).toBe("kacha:clip:v1:1");
    expect(nodeMarker(12)).toBe("kacha:clip:v1:12");
  });

  it("判定：计数从 1 起、允许首尾空白；0、多一位前导零、别的前缀、空串与 null 都不算", () => {
    for (const text of ["kacha:clip:v1:1", "kacha:clip:v1:37", "  kacha:clip:v1:2\n"]) expect(isNodeMarker(text)).toBe(true);
    for (const text of [null, "", "   ", "kacha:clip:v1:", "kacha:clip:v1:0", "kacha:clip:v1:01", "kacha:clip:v1:-1", "kacha:clip:v1:1.5", "kacha:clip:v2:1", "KACHA:CLIP:V1:1", "一图", "kacha:clip:v1:1 两个节点"]) {
      expect(isNodeMarker(text)).toBe(false);
    }
  });

  it("剪贴板图片独立限制为 64 MiB，产物使用粘贴前缀", () => {
    // 独立期望值固定剪贴板内存预算与用户可见名字。
    expect(MAX_PASTE_BYTES).toBe(67108864);
    expect(PASTE_NAME_PREFIX).toBe("粘贴");
  });


});

describe("复制模式", () => {
  it("单选参考图节点：复制图片", () => {
    const board = newBoard();
    board.nodes = [{ id: "r1", type: "reference", pos: [0, 0], size: [200, 200], extra: {}, path: "参考/cat.png", sha256: "a".repeat(64), display_name: "cat.png" }];
    expect(copyTarget(board, ["r1"]).mode).toBe("image");
  });

  it("单选结果节点：复制底图，不复制图层或节点", () => {
    const board = newBoard();
    board.nodes = [{ id: "res1", type: "result", pos: [0, 0], size: [200, 200], extra: {}, task_id: "t1", file: "result.png", path: "任务/t1/result.png", layer_count: 1, record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: null, ratio: null, width: null, height: null }, submitted_at: "2026-11-11T00:00:00Z", layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [0, 0, 1, 1] }] } }];
    expect(copyTarget(board, ["res1"]).mode).toBe("image");
  });

  it("多选即使含图片：仍复制节点，画板内复制粘贴手感不变", () => {
    const board = newBoard();
    board.nodes = [
      { id: "r1", type: "reference", pos: [0, 0], size: [200, 200], extra: {}, path: "参考/cat.png", sha256: "a".repeat(64), display_name: "cat.png" },
      { id: "p1", type: "prompt", pos: [300, 0], size: [240, 120], extra: {}, text: "一只猫" },
    ];
    expect(copyTarget(board, ["r1", "p1"]).mode).toBe("nodes");
  });

  it("提示词、任务、失效节点 id 与空选区：都不是图片复制", () => {
    const board = newBoard();
    board.nodes = [
      { id: "p1", type: "prompt", pos: [0, 0], size: [240, 120], extra: {}, text: "一只猫" },
      { id: "t1", type: "task", pos: [300, 0], size: [280, 260], extra: {}, model: "m", size_spec: { tier: null, ratio: null, width: null, height: null }, image_ports: 1, layer_decomposition: false, transparent_background: false, last_submitted: null },
    ];
    for (const ids of [["p1"], ["t1"], ["gone"], []]) expect(copyTarget(board, ids).mode).toBe("nodes");
  });
});

describe("粘贴图片的显示名", () => {
  /** 本地时间 2026-11-11 11:56：期望值都写成这个时刻的产物名。 */
  const NOW = new Date(2026, 10, 11, 11, 56);
  const taken = (...names: string[]) => new Set(names);

  /**
   * 每个上传后的相对路径给一个显示名。期望值手写，不复用被测函数算。
   * taken = 画板里已有的显示名。
   */
  const CASES: { name: string; paths: readonly string[]; taken: ReadonlySet<string>; expected: string[] }[] = [
    { name: "同一分钟的单张：粘贴-年月日-时分.扩展名", paths: ["导入参考图/1f3a.png"], taken: taken(), expected: ["粘贴-20261111-1156.png"] },
    { name: "扩展名照路径小写", paths: ["截图.JPEG"], taken: taken(), expected: ["粘贴-20261111-1156.jpeg"] },
    { name: "不同扩展名不是重名，不追加序号", paths: ["a.png", "b.jpg"], taken: taken(), expected: ["粘贴-20261111-1156.png", "粘贴-20261111-1156.jpg"] },
    // 目录名里带点不算扩展名：只看最后一段文件名。
    { name: "路径没有扩展名就不加后缀", paths: ["v1.2/截图"], taken: taken(), expected: ["粘贴-20261111-1156"] },
    // 同一分钟多张：第一张用原名，第二张从 -2 起找第一个没人用的。
    { name: "同扩展名两张：第二张追加 -2", paths: ["a.png", "b.png"], taken: taken(), expected: ["粘贴-20261111-1156.png", "粘贴-20261111-1156-2.png"] },
    { name: "与画板里已有的名字冲突：追加 -2", paths: ["a.png"], taken: taken("粘贴-20261111-1156.png"), expected: ["粘贴-20261111-1156-2.png"] },
    { name: "原名与 -2 都被占用：追加 -3", paths: ["a.png"], taken: taken("粘贴-20261111-1156.png", "粘贴-20261111-1156-2.png"), expected: ["粘贴-20261111-1156-3.png"] },
    { name: "同批先到的也算占用：与 taken 一起跳过", paths: ["a.png", "b.png"], taken: taken("粘贴-20261111-1156.png"), expected: ["粘贴-20261111-1156-2.png", "粘贴-20261111-1156-3.png"] },
    { name: "无扩展名的两张：序号接在名字后", paths: ["x", "y"], taken: taken(), expected: ["粘贴-20261111-1156", "粘贴-20261111-1156-2"] },
  ];

  for (const c of CASES) it(c.name, () => expect(pasteDisplayNames(NOW, c.paths, c.taken)).toEqual(c.expected));
});

// ---- 页面级默认行为（#97） ----
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