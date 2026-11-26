// 上下文菜单的弹出层：条目由 core/contextMenu 按对象给出，这里只负责摆放、置灰与关闭。
// 键盘链路也归这一层：打开即聚焦首个可用项，方向键 / Home / End 导航，回车 / 空格执行，
// Esc 关闭并把焦点还给打开菜单前的元素；不新增可见按钮。
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { clampMenuPosition, type BoardAction, type MenuItem } from "../core/contextMenu";
import { textHoverInfo } from "../core/hoverInfo";
import { HoverButton } from "./hoverInfo";

interface Props {
  at: { x: number; y: number };
  items: MenuItem[];
  onPick: (action: BoardAction) => void;
  onClose: () => void;
}

/** 可用条目的下标：置灰项不参与导航。 */
function enabledIndices(items: MenuItem[]): number[] {
  return items.flatMap((item, index) => (item.disabledReason === null ? [index] : []));
}

/** 第一个可用项；全是置灰项时返回 -1。 */
function firstEnabled(items: MenuItem[]): number {
  return enabledIndices(items)[0] ?? -1;
}

/** 在可用项之间循环；当前项失效时从首 / 尾开始。 */
function wrap(enabled: number[], current: number, delta: number): number {
  const at = enabled.indexOf(current);
  if (at < 0) return delta > 0 ? enabled[0] : enabled[enabled.length - 1];
  return enabled[(at + delta + enabled.length) % enabled.length];
}

/** 方向键 / Home / End 落到哪一项；非导航键返回 null。 */
function activeAfterKey(items: MenuItem[], active: number, key: string): number | null {
  const enabled = enabledIndices(items);
  if (!enabled.length) return null;
  switch (key) {
    case "ArrowDown": return wrap(enabled, active, 1);
    case "ArrowUp": return wrap(enabled, active, -1);
    case "Home": return enabled[0];
    case "End": return enabled[enabled.length - 1];
    default: return null;
  }
}

interface KeyboardDeps {
  menu: RefObject<HTMLDivElement | null>;
  items: RefObject<MenuItem[]>;
  active: RefObject<number>;
  setActive: (index: number) => void;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  onPick: (action: BoardAction) => void;
}

/** 菜单开着时的键盘监听：捕获阶段吞掉按键，避免背后的画板同时响应。 */
function useMenuKeyboard({ menu, items, active, setActive, opener, onClose, onPick }: KeyboardDeps): void {
  useEffect(() => {
    const closeWithFocusReturn = () => {
      opener.current?.focus();
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const next = activeAfterKey(items.current, active.current, e.key);
      if (next !== null) {
        e.preventDefault();
        e.stopPropagation();
        active.current = next;
        setActive(next);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const item = items.current[active.current];
        if (item && item.disabledReason === null) {
          closeWithFocusReturn();
          onPick(item.action);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeWithFocusReturn();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, items, active, setActive, opener, onClose, onPick]);
}

/** 单个条目：置灰原因用悬浮层说明，键盘当前项用 aria-current 标出。 */
function MenuRow({ item, active, onPick }: { item: MenuItem; active: boolean; onPick: (action: BoardAction) => void }) {
  return (
    <Fragment>
      {item.separatorBefore && <div className="context-menu-separator" role="separator" />}
      <HoverButton
        role="menuitem"
        aria-current={active ? "true" : undefined}
        disabled={item.disabledReason !== null}
        info={item.disabledReason ? textHoverInfo(item.disabledReason) : null}
        onClick={() => onPick(item.action)}
      >
        {item.label}
      </HoverButton>
    </Fragment>
  );
}

export function ContextMenu({ at, items, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [active, setActive] = useState<number>(() => firstEnabled(items));
  const opener = useRef<HTMLElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(clampMenuPosition(at, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at, items]);

  useEffect(() => {
    const menu = ref.current;
    opener.current = document.activeElement as HTMLElement | null;
    return () => {
      if (menu?.contains(document.activeElement)) opener.current?.focus();
    };
  }, []);

  useEffect(() => {
    if (enabledIndices(items).includes(active)) return;
    const next = firstEnabled(items);
    activeRef.current = next;
    setActive(next);
  }, [items, active]);

  useEffect(() => {
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    (buttons?.[active] ?? ref.current)?.focus();
  }, [active, items]);

  useMenuKeyboard({ menu: ref, items: itemsRef, active: activeRef, setActive, opener, onClose, onPick });

  return (
    <div className="context-menu" role="menu" tabIndex={-1} ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, index) => (
        <MenuRow key={item.action} item={item} active={index === active} onPick={(action) => {
          opener.current?.focus();
          onClose();
          onPick(action);
        }} />
      ))}
    </div>
  );
}
