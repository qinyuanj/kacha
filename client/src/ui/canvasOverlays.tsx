// 画布上浮在 React Flow 之上的几层：整理条、上下文菜单、放大预览弹窗、共享的悬浮信息层（挂在画布根 div 里，
// 这些浮层是 position:fixed / 绝对定位，不能进 React Flow 的变换容器），以及悬浮动作条（必须挂在 React Flow 内部，
// NodeToolbar 靠它的 store 定位）。每个浮层各自判空（没开 / 没有条目就 return null），调用方只按顺序摆放。
import { NodeToolbar, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import type { BoardAction, MenuItem } from "../core/contextMenu";
import { ActionBar } from "./ActionBar";
import { ContextMenu } from "./ContextMenu";
import { PreviewDialog } from "./PreviewDialog";
import { TidyBar, type TidyMeasure } from "./tidy";
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
  /** 整理模式：false 时不出整理条。 */
  tidying: boolean;
  /** 整理模式量到的体量（见 useTidyMeasure）。 */
  tidyMeasure: TidyMeasure;
  /** 点整理条的「完成」：退出整理模式。 */
  onTidyDone: () => void;
  /** 共享的悬浮信息层（useHoverLayer().layer）；没有内容时为 null。 */
  hoverLayer: ReactNode;
}

export function CanvasOverlays(props: CanvasOverlaysProps) {
  return (
    <>
      <TidyOverlay tidying={props.tidying} measure={props.tidyMeasure} onDone={props.onTidyDone} />
      <MenuOverlay menu={props.menu} entries={props.menuEntries} onPick={props.onPickMenu} onClose={props.onCloseMenu} />
      <PreviewOverlay preview={props.preview} toast={props.toast} onClose={props.onClosePreview} />
      {props.hoverLayer}
    </>
  );
}

export interface CanvasActionBarProps {
  /** 有节点在悬浮 / 动作条该显示：false 时不出。 */
  present: boolean;
  /** 动作条对应的节点 id（多选内的节点悬浮时给整个选区）。 */
  nodes: string[];
  /** 动作条条目：空时不出。 */
  items: MenuItem[];
  onPick: (action: BoardAction) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/** 悬浮动作条：由画布放进 React Flow 内（NodeToolbar 需要它的 store）；固定屏幕像素、不随缩放。 */
export function CanvasActionBar({ present, nodes, items, onPick, onPointerEnter, onPointerLeave }: CanvasActionBarProps) {
  if (!present || items.length === 0) return null;
  return (
    <NodeToolbar nodeId={nodes} isVisible position={Position.Top}>
      <ActionBar items={items} onPick={onPick} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} />
    </NodeToolbar>
  );
}

/** 整理条（#92）：不在整理模式不出。 */
function TidyOverlay({ tidying, measure, onDone }: { tidying: boolean; measure: TidyMeasure; onDone: () => void }) {
  if (!tidying) return null;
  return <TidyBar {...measure} onDone={onDone} />;
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
