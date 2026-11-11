import { describe, expect, it } from "vitest";
import { MAX_CONTENT_BYTES } from "./boardPack";
import { dispatchPaste, isNodeMarker, MAX_PASTE_BYTES, NODE_MARKER_PREFIX, nodeMarker, PASTE_NAME_PREFIX, pasteDisplayNames, type PasteAction, type PasteContext, type PasteFacts } from "./pageInput";

/** 画布落点（默认）。 */
const AT: [number, number] = [120, -40];

function facts(patch: Partial<PasteFacts> = {}): PasteFacts {
  return { text: null, images: 0, opaqueFiles: 0, ...patch };
}

function context(patch: Partial<PasteContext> = {}): PasteContext {
  return { board: true, readOnly: false, modal: false, textFocus: false, hasNodeClip: false, at: AT, ...patch };
}

const PASS: PasteAction = { kind: "pass" };
const PASTE_NODES: PasteAction = { kind: "pasteNodes" };

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

  it("粘贴上限与产物名前缀是界面与 e2e 都要 import 的跨层常量", () => {
    // 手写独立期望值，两处都对服务端与用户可见名字负责：上限改动服务端会先拒，前缀改动 e2e 会找不到节点。
    expect(MAX_PASTE_BYTES).toBe(67108864);
    expect(PASTE_NAME_PREFIX).toBe("粘贴");
  });

  it("粘贴上限与画板包的单份上限都跟着服务端的单请求上限走：改一处忘了另一处会在这里现形", () => {
    expect(MAX_PASTE_BYTES).toBe(MAX_CONTENT_BYTES);
  });
});

describe("粘贴分派", () => {
  /**
   * 每条分支一行：剪贴板事实 + 界面状态 → 一个可执行结果。期望值手写，不复用被测分支的判断。
   * board = 当前打开着一块画板；modal = 有模态弹出；textFocus = 焦点在文本输入里；hasNodeClip = 应用内剪贴板里有可粘的节点。
   */
  const CASES: { name: string; facts: Partial<PasteFacts>; context: Partial<PasteContext>; expected: PasteAction }[] = [
    // 标记命中：只读先于内存剪贴板判定——画板不可写，有没有可粘的节点都没用。
    { name: "标记命中且有内存剪贴板：粘节点", facts: { text: "kacha:clip:v1:2" }, context: { hasNodeClip: true }, expected: PASTE_NODES },
    { name: "标记命中但内存剪贴板已空（刷新过页面、另一个标签页）：吞掉并提示重新复制", facts: { text: "kacha:clip:v1:2" }, context: {}, expected: { kind: "refuse", reason: "staleNodeClip" } },
    { name: "只读画板 + 标记：拒绝，而不是提示重新复制", facts: { text: "kacha:clip:v1:2" }, context: { readOnly: true, hasNodeClip: true }, expected: { kind: "refuse", reason: "readOnly" } },
    // 标记先于输入框：粘的是应用写的标记文本，说明用户想粘节点，不是想往提示词里贴这行字。
    { name: "标记命中时焦点在输入框里也粘节点", facts: { text: "kacha:clip:v1:2" }, context: { textFocus: true, hasNodeClip: true }, expected: PASTE_NODES },
    // 剪贴板里是图片：落成参考图节点的入口，落点用画布坐标。
    { name: "有图片：落成参考图，落点取界面给的坐标", facts: { images: 1 }, context: {}, expected: { kind: "importImages", at: [120, -40] } },
    { name: "只读画板 + 图片：拒绝", facts: { images: 1 }, context: { readOnly: true }, expected: { kind: "refuse", reason: "readOnly" } },
    { name: "图片 + 读不到内容的文件：落图，读不到的文件不改变分派", facts: { images: 2, opaqueFiles: 3 }, context: {}, expected: { kind: "importImages", at: [120, -40] } },
    // 输入框：粘文本的行为保持不变（文本优先于图片，别把用户输了一半的提示词变成参考图）。
    { name: "输入框里粘文本：放行给输入框", facts: { text: "一只猫" }, context: { textFocus: true }, expected: PASS },
    { name: "输入框里同时有文本和图片：放行文本", facts: { text: "一只猫", images: 1 }, context: { textFocus: true }, expected: PASS },
    { name: "输入框里粘只有图片没有文本：仍然落图", facts: { images: 1 }, context: { textFocus: true }, expected: { kind: "importImages", at: [120, -40] } },
    { name: "纯文本不在输入框里：放行给浏览器", facts: { text: "一段说明" }, context: {}, expected: PASS },
    // 读不到内容的文件：浏览器不给页面读文件本身，只能提示用户拖进来，吞掉以免浏览器把当前页导航走。
    { name: "只有读不到内容的文件：拒绝并提示拖入", facts: { opaqueFiles: 1 }, context: {}, expected: { kind: "refuse", reason: "filesNotReadable" } },
    { name: "空剪贴板：放行", facts: {}, context: {}, expected: PASS },
  ];

  for (const c of CASES) it(c.name, () => expect(dispatchPaste(facts(c.facts), context(c.context))).toEqual(c.expected));

  it("登录页 / 没有画板：无论剪贴板里是什么都放行", () => {
    expect(dispatchPaste(facts(), context({ board: false }))).toEqual(PASS);
    expect(dispatchPaste(facts({ images: 2 }), context({ board: false, readOnly: true }))).toEqual(PASS);
  });

  it("有模态弹出：粘贴照常，背后的画板不生成节点", () => {
    expect(dispatchPaste(facts({ text: "kacha:clip:v1:2" }), context({ modal: true, hasNodeClip: true }))).toEqual(PASS);
    expect(dispatchPaste(facts({ images: 1 }), context({ modal: true }))).toEqual(PASS);
    // 只读归档里弹出的模态（例如设置）同样放行：粘贴的目标是弹窗，不是背后的画板。
    expect(dispatchPaste(facts({ images: 1 }), context({ modal: true, readOnly: true }))).toEqual(PASS);
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
