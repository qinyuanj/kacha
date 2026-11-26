// 画布上浮在 React Flow 之上的几层：上下文菜单、放大预览弹窗与共享的悬浮信息层，都挂在画布根 div 里；
// 这些浮层是 position:fixed / 绝对定位，不进 React Flow 的变换容器。每层各自判空，调用方只按顺序摆放。
import type { ReactNode } from "react";
import type { BoardAction, MenuItem } from "../core/contextMenu";
import { ContextMenu } from "./ContextMenu";
import { PreviewDialog } from "./PreviewDialog";
import type { CanvasMenuState, CanvasPreviewState } from "./useCanvasOverlaysState";

export interface CanvasOverlaysProps {
  /** 上下文菜单状态；null = 没开。 */
  menu: CanvasMenuState | null;
  /** 菜单条目：已按菜单目标、选区与归档画板筛过（见 core/contextMenu 与 core/archive）。 */
  menuEntries: MenuItem[];
  onPickMenu: (action: BoardAction) => void;
  onCloseMenu: () => void;
  /** 放大预览弹窗状态；null = 没开。 */
  preview: CanvasPreviewState | null;
  onClosePreview: () => void;
  toast: (message: string) => void;
  /** 共享的悬浮信息层（useHoverLayer().layer）；没有内容时为 null。 */
  hoverLayer: ReactNode;
}

export function CanvasOverlays(props: CanvasOverlaysProps) {
  return (
    <>
      <MenuOverlay menu={props.menu} entries={props.menuEntries} onPick={props.onPickMenu} onClose={props.onCloseMenu} />
      <PreviewOverlay preview={props.preview} toast={props.toast} onClose={props.onClosePreview} />
      {props.hoverLayer}
    </>
  );
}

interface MenuOverlayProps {
  menu: CanvasMenuState | null;
  entries: MenuItem[];
  onPick: (action: BoardAction) => void;
  onClose: () => void;
}

/** 上下文菜单：没开、或当前目标没有条目（系统连线、未知节点）时不出。 */
function MenuOverlay({ menu, entries, onPick, onClose }: MenuOverlayProps) {
  if (!menu) return null;
  if (entries.length === 0) return null;
  return <ContextMenu at={menu.client} items={entries} onPick={onPick} onClose={onClose} />;
}

interface PreviewOverlayProps {
  preview: CanvasPreviewState | null;
  toast: (message: string) => void;
  onClose: () => void;
}

/** 放大预览弹窗：nonce 变化即重挂（同一个节点再打开时区域编辑、勾选的图层都从头开始）。 */
function PreviewOverlay({ preview, toast, onClose }: PreviewOverlayProps) {
  if (!preview) return null;
  return <PreviewDialog key={preview.nonce} req={preview.req} toast={toast} onClose={onClose} />;
}
