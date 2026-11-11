// 悬浮动作条：光标在图片节点或动作条上时显示，从节点移到动作条之间留一点宽限（150ms）。
// 显示什么由 actionBarView 从 hovered / 画板 / 选区 / 菜单推导，hook 只管状态与定时器。
import { useEffect, useRef, useState } from "react";
import { actionBarItems, type MenuFacts, type MenuItem } from "../core/contextMenu";

interface ActionBarViewInput {
  /** 悬浮的节点 id；null = 没有悬浮。 */
  hovered: string | null;
  /** 画板上的节点：悬浮的那个可能已被撤销 / 删除。 */
  nodes: readonly { id: string }[];
  /** 上下文菜单开着：动作条让位。 */
  menuOpen: boolean;
  /** 只读画板的条目过滤（readOnly 时为 readOnlyMenu，否则原样返回）。 */
  menuView: (items: MenuItem[]) => MenuItem[];
  /** 菜单事实：按当前选区换过（原 menuFacts(selectedNodes)）。 */
  facts: MenuFacts;
}

/** 动作条要显示的内容；present = 有条目可显示（原 JSX 的 barItems.length > 0）。 */
interface ActionBarView {
  present: boolean;
  /** NodeToolbar 挂到哪些节点上（原 barNodes）。 */
  nodes: string[];
  items: MenuItem[];
}

/** 悬浮在多选内的节点上：选区上方只出一条（原 barNodes 的推导）。 */
function barNodesOf(hovered: string, selected: ReadonlySet<string>): string[] {
  return selected.size > 1 && selected.has(hovered) ? [...selected] : [hovered];
}

/** 动作条的内容：悬浮的节点还在画板上、菜单没开着，才有条目（原 hoveredPresent / barItems / barNodes）。 */
export function actionBarView({ hovered, nodes, menuOpen, menuView, facts }: ActionBarViewInput): ActionBarView {
  if (hovered === null || !nodes.some((n) => n.id === hovered)) return { present: false, nodes: [], items: [] };
  const items = menuOpen ? [] : menuView(actionBarItems(hovered, facts));
  return { present: items.length > 0, nodes: barNodesOf(hovered, facts.selected), items };
}

interface ActionBarHover {
  /** 悬浮的节点 id（要显示动作条的那个）；null = 不显示。 */
  hovered: string | null;
  /** id = 显示该节点的动作条；null = 只取消待收起。 */
  showActionBar: (id: string | null) => void;
  /** 光标离开节点 / 动作条：留 150ms 宽限，这期间进入动作条就继续显示。 */
  hideActionBarSoon: () => void;
  /** 节点卸载（离开视口、被删）时立即收起它的动作条：收不到 mouseleave，回到视口时不能无故弹出。 */
  unhoverNode: (id: string) => void;
}

/** 悬浮动作条的状态：hovered、显示 / 宽限收起、卸载清理。 */
export function useActionBarHover(): ActionBarHover {
  // 悬浮动作条：光标在图片节点或动作条上时显示；从节点移到动作条之间留一点宽限。
  const [hovered, setHovered] = useState<string | null>(null);
  const unhoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showActionBar = (id: string | null) => {
    if (unhoverTimer.current !== null) clearTimeout(unhoverTimer.current);
    unhoverTimer.current = null;
    if (id !== null) setHovered(id);
  };
  const hideActionBarSoon = () => {
    showActionBar(null);
    unhoverTimer.current = setTimeout(() => setHovered(null), 150);
  };
  const unhoverNode = (id: string) => setHovered((h) => (h === id ? null : h));
  // 卸载时连待收起的定时器一起清掉（卸载后再 setHovered 没有意义）。
  useEffect(() => () => showActionBar(null), []);
  return { hovered, showActionBar, hideActionBarSoon, unhoverNode };
}
