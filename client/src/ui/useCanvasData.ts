// 画布要读的画板外部事实：节点引用的图片信息与透明通道、读不到的图片、本次运行 / 任务目录推导出的任务状态。
// 只负责取数与把它们拼成节点渲染要用的形状；写入（补算自动宽高比）经 applyChange 交给画板会话。
import { useCallback, useEffect, useMemo } from "react";
import type { Board } from "../core/board";
import type { CapabilityTable } from "../core/capabilities";
import type { BoardChange, EditResult } from "../core/edit";
import { nodeImages, type NodeImage } from "../core/graph";
import type { TaskStatus } from "../core/run";
import { nodeStatus, type NodeRunState } from "../core/runner";
import type { ImageInfo } from "../shell/ipc";
import { useImageInfos, useMissingImages, useStoredStatuses } from "./context";

/** 每个图片源节点的透明通道；未知的不进 Map（节点按「不知道」渲染）。 */
function alphaByNodeOf(images: readonly NodeImage[], imageInfos: ReadonlyMap<string, ImageInfo | null>): ReadonlyMap<string, boolean> {
  const map = new Map<string, boolean>();
  for (const img of images) {
    const info = imageInfos.get(img.absPath);
    if (info) map.set(img.key, info.has_alpha);
  }
  return map;
}

interface Options {
  board: Board;
  boardFile: string;
  userRoot: string;
  table: CapabilityTable;
  locked: ReadonlySet<string>;
  handled: ReadonlySet<string>;
  runNodes: ReadonlyMap<string, NodeRunState>;
  applyChange: (change: BoardChange) => EditResult | null;
}

export interface CanvasData {
  /** 绝对路径 → 图片信息；读取失败为 null。 */
  imageInfos: ReadonlyMap<string, ImageInfo | null>;
  /** 图片源节点 key → 是否有透明通道。 */
  alphaByNode: ReadonlyMap<string, boolean>;
  /** 读不到的图片对应的节点 id。 */
  missing: ReadonlySet<string>;
  /** 本次运行经手过的以运行器为准，否则按任务目录推导（重开后）。 */
  runStateOf: (taskId: string) => NodeRunState | undefined;
  statusOf: (taskId: string) => TaskStatus | null;
}

export function useCanvasData({ board, boardFile, userRoot, table, locked, handled, runNodes, applyChange }: Options): CanvasData {
  // 每个图片源节点的透明通道（导入 / 定位时已有缓存，未读的批量补读）；未知不进入 Map。
  const images = useMemo(() => board.nodes.flatMap((n) => nodeImages(n, userRoot)), [board.nodes, userRoot]);
  const imageAbsPaths = useMemo(() => images.map((img) => img.absPath), [images]);
  const imageInfos = useImageInfos(imageAbsPaths);
  // 图片宽高晚于画板变更读到（刚打开画板、刚重新定位）、任务结束解除锁定、能力表或用户数据根变化时补算自动宽高比：
  // 系统变更，不构成撤销步；环境经 apply 取最新，这里的依赖只决定何时补算。
  useEffect(() => {
    applyChange({ kind: "syncAutoRatios" });
  }, [board, imageInfos, locked, table, userRoot, applyChange]);
  const alphaByNode = useMemo(() => alphaByNodeOf(images, imageInfos), [images, imageInfos]);
  const missing = useMissingImages(board, userRoot);

  const stored = useStoredStatuses(board, boardFile, userRoot, handled);
  // 本次运行经手过的以运行器为准；否则按任务目录推导（重开后），两者同形、同样按节点聚合。
  const runStateOf = useCallback((taskId: string): NodeRunState | undefined => runNodes.get(taskId) ?? stored.get(taskId), [runNodes, stored]);
  const statusOf = useCallback((taskId: string): TaskStatus | null => nodeStatus(runStateOf(taskId)), [runStateOf]);

  return { imageInfos, alphaByNode, missing, runStateOf, statusOf };
}
