// @vitest-environment jsdom
// 页面输入接管的挂载：判定本身的用例在 core/pageInput.test.ts，这里用真实的 jsdom window 核对接线——
// 挂上去之后真实事件该吞的吞、该放的放，卸载之后不再吞。两个函数都在改动文件的覆盖率范围里（docs/adr/0020）。
import { afterEach, describe, expect, it } from "vitest";
import { installPageInputTakeover, isEditableTarget } from "./pageInput";

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

/** 派发一个事件（target 默认 window），返回它是否被吞掉。 */
function swallowed(event: Event, target: EventTarget = window): boolean {
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const key = (patch: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...patch });
const mouse = (type: string, button: number) => new MouseEvent(type, { button, cancelable: true, bubbles: true });

/** jsdom 没有 DataTransfer，给拖放事件补上接管会读的那个字段。 */
function drag(type: string, types: string[] | null): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: types === null ? null : { types } });
  return event;
}

/** 挂在 document.body 上的可编辑控件：事件要能冒泡到 window 才算数。 */
function editable(tag: string): HTMLElement {
  const el = document.createElement(tag);
  document.body.append(el);
  return el;
}

describe("可编辑目标", () => {
  it("输入框、文本域、下拉与内容可编辑算可编辑", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isEditableTarget(editable(tag))).toBe(true);
    }
    // jsdom 不实现 contentEditable 属性，按浏览器里它反射出的属性来写。
    const rich = document.createElement("div");
    rich.setAttribute("contenteditable", "true");
    document.body.append(rich);
    expect(isEditableTarget(rich)).toBe(true);
    // 焦点 / 点击落在内容可编辑的子孙节点上也算。
    expect(isEditableTarget(document.createElement("span"))).toBe(false);
    const nested = document.createElement("span");
    rich.append(nested);
    expect(isEditableTarget(nested)).toBe(true);
  });

  it("普通元素、body 与空目标不算可编辑", () => {
    expect(isEditableTarget(editable("div"))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("挂载后的处置", () => {
  it("键盘：被拦的组合吞掉，放行的组合不碰", () => {
    uninstall = installPageInputTakeover();
    expect(swallowed(key({ key: "s", ctrlKey: true }))).toBe(true);
    expect(swallowed(key({ key: "ArrowLeft", altKey: true }))).toBe(true);
    expect(swallowed(key({ key: "ArrowDown" }))).toBe(true);
    expect(swallowed(key({ key: "a", ctrlKey: true }))).toBe(false);
    // 输入区里的方向键是原生光标移动。
    expect(swallowed(key({ key: "ArrowDown" }), editable("textarea"))).toBe(false);
  });

  it("拖放：带文件的 dragover 与 drop 都吞掉，纯文本与缺 dataTransfer 的不碰", () => {
    uninstall = installPageInputTakeover();
    for (const type of ["dragover", "drop"]) {
      expect(swallowed(drag(type, ["Files"]))).toBe(true);
      expect(swallowed(drag(type, ["text/plain"]))).toBe(false);
      expect(swallowed(drag(type, null))).toBe(false);
    }
  });

  it("鼠标：中键按下与侧键松开吞掉，左键按下、中键松开不碰", () => {
    uninstall = installPageInputTakeover();
    expect(swallowed(mouse("mousedown", 1))).toBe(true);
    expect(swallowed(mouse("mousedown", 0))).toBe(false);
    for (const button of [3, 4]) expect(swallowed(mouse("mouseup", button))).toBe(true);
    expect(swallowed(mouse("mouseup", 1))).toBe(false);
  });

  it("滚轮与捏合一概不碰：画布外的 Ctrl+滚轮仍是页面缩放的逃生口", () => {
    uninstall = installPageInputTakeover();
    const zoom = new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, cancelable: true, bubbles: true });
    expect(swallowed(zoom)).toBe(false);
  });

  it("卸载后不再吞任何默认行为", () => {
    uninstall = installPageInputTakeover();
    uninstall();
    uninstall = null;
    expect(swallowed(key({ key: "s", ctrlKey: true }))).toBe(false);
    expect(swallowed(mouse("mousedown", 1))).toBe(false);
    expect(swallowed(drag("drop", ["Files"]))).toBe(false);
  });
});
