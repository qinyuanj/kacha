// 画布的坐标与 DOM 落点：连线 id、取整坐标、指针的窗口坐标、松手处落在哪个元素上。
// 这里只有纯计算；画布组件与事件处理都从这里取。
import type { BoardEdge } from "../core/board";

/** React Flow 连线 id：与画板连线的端点一一对应（系统连线也在内）。 */
export const edgeIdOf = (e: BoardEdge) => `${e.from.join(":")}->${e.to.join(":")}`;

/** 新建类节点落点：画布坐标取整，避免亚像素位置写进画板文件。 */
export function posOf(p: { x: number; y: number }): [number, number] {
  return [Math.round(p.x), Math.round(p.y)];
}

/** 画布根元素的类名：拖线中加一个标记（标记是 CSS 的消费单位，不带多余空格）。 */
export function canvasClassName(drag: boolean): string {
  return ["canvas", drag && "connecting"].filter(Boolean).join(" ");
}

/** 指针事件的窗口坐标（鼠标或触控）。 */
export function clientPointOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("changedTouches" in event) {
    const t = event.changedTouches[0];
    return { x: t?.clientX ?? 0, y: t?.clientY ?? 0 };
  }
  return { x: event.clientX, y: event.clientY };
}

/** 落点：节点卡片、画布空白（含连线），其余（工具栏、小地图、控件、动作条等）为 null。 */
export type DropTarget = { kind: "node"; nodeId: string } | { kind: "pane" };

/**
 * 窗口坐标处的落点：节点卡片、画布空白（含连线），其余（工具栏、小地图、控件、动作条等）为 null。
 * 命中元素取 document.elementFromPoint，与浏览器里真实的落点判定同一条路。
 */
export function dropTargetAt(client: { x: number; y: number }): DropTarget | null {
  const el = document.elementFromPoint(client.x, client.y);
  const node = el?.closest(".react-flow__node");
  const nodeId = node?.getAttribute("data-id");
  if (nodeId) return { kind: "node", nodeId };
  if (!el?.closest(".react-flow") || el.closest(".react-flow__panel, .react-flow__node-toolbar")) return null;
  return { kind: "pane" };
}
