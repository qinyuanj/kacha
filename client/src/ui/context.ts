import { createContext, useEffect, useState } from "react";
import type { Board, PortRef } from "../core/board";
import type { CapabilityTable, ModelCapability } from "../core/capabilities";
import type { BoardAction, MenuTarget } from "../core/contextMenu";
import type { BoardChange } from "../core/edit";
import { nodeImages } from "../core/graph";
import type { NodeRunState } from "../core/runner";
import { createInterruptedLog, interruptedCandidates, storedStatuses } from "../core/submission";
import type { TaskFs } from "../core/taskDir";
import type { ImageInfo } from "../shell/port";
import { useShell } from "./shell";
import { useRequiredContext } from "./requiredContext";
import { createImageInfoCache } from "./imageInfoCache";

export interface BoardActions {
  table: CapabilityTable;
  userRoot: string;
  /** 任务节点模型下拉：网关发现 ∩ 上架清单。 */
  availableModels: ModelCapability[];
  /** 页面当前的并发上限：份数控件的可选上界（不据此改写画板里的份数）。 */
  concurrency: number;
  /** 画板变更的唯一写入口（见 core/edit）：被拒或需告知时提示原因。 */
  apply: (change: BoardChange) => void;
  /** 迭代动作：触发节点在多选内时按选中顺序带上其余图片节点；sourceLayer（1 起）= 接该图层而非合成结果；at = 新任务左上角的画布坐标（拖线建节点）。 */
  continueEditing: (nodeId: string, sourceLayer?: number | null, at?: { x: number; y: number }) => void;
  addAsReference: (resultId: string, sourceLayer?: number | null) => void;
  generateVariant: (resultId: string) => void;
  /** 缺图节点：pick = 选文件，search = 在数据根内按身份找。 */
  relocate: (nodeId: string, mode: "pick" | "search") => void;
  /** 参考图 / 结果节点的「放大预览」：弹窗里可再选扇出任务编辑区域。 */
  previewNode: (nodeId: string) => void;
  /** 任务端口行的「指示区域」：直接编辑该条连线的区域。 */
  editRegion: (taskId: string, ref: { from: PortRef; to: PortRef }) => void;
  /**
   * 执行一个画板动作：上下文菜单、节点上的运行 / 展开按钮共用；条目与置灰原因由 core/contextMenu 给出。
   * at = 新建类动作的落点（画布坐标），缺省 = 视口中央。
   */
  perform: (action: BoardAction, target: MenuTarget, at?: { x: number; y: number }) => void;
  /**
   * 画布只渲染可见节点：下面两项把节点上的瞬时状态交给画布保管，卸载后再挂载时仍在。
   * 提示词等待三选一的未提交文本（null = 没有），按节点 id 存在画布上，节点卸载后再挂载时仍在。
   */
  setPromptDraft: (promptId: string, text: string | null) => void;
  /**
   * 新建提示词的一次性聚焦请求：仍指向该提示词时返回 true 并清除（只聚焦一次）。节点据此决定是否聚焦，
   * 不只看节点 data 里的 autoFocus——xyflow 拿到的节点数据会晚画布一次提交。
   */
  takePromptFocus: (promptId: string) => boolean;
}

export const BoardContext = createContext<BoardActions | null>(null);

export function useBoardActions(): BoardActions {
  return useRequiredContext(BoardContext, "BoardContext 未提供");
}

// 图片信息的缓存与同步视图（见 ui/imageInfoCache.ts）。
const imageInfoCache = createImageInfoCache();

export function useImageInfo(absPath: string | null): ImageInfo | null | undefined {
  const port = useShell();
  const [info, setInfo] = useState<ImageInfo | null | undefined>(undefined);
  useEffect(() => {
    if (absPath === null) return setInfo(undefined);
    let alive = true;
    void imageInfoCache.read(port.files.inspectImage, absPath).then((value) => alive && setInfo(value));
    return () => {
      alive = false;
    };
  }, [absPath]);
  return info;
}

export function primeImageInfo(absPath: string, info: ImageInfo): void {
  imageInfoCache.prime(absPath, info);
}

/** 已经读到过的图片信息；还没读到或读取失败为 undefined。 */
export function knownImageInfo(absPath: string): ImageInfo | undefined {
  return imageInfoCache.known(absPath);
}

/** 批量读取图片信息（画布级：透明通道接线等）；path → 信息，读取失败为 null。 */
export function useImageInfos(absPaths: string[]): ReadonlyMap<string, ImageInfo | null> {
  const port = useShell();
  const [infos, setInfos] = useState<ReadonlyMap<string, ImageInfo | null>>(new Map());
  const signature = JSON.stringify(absPaths);
  useEffect(() => {
    let alive = true;
    void Promise.all(absPaths.map(async (abs) => [abs, await imageInfoCache.read(port.files.inspectImage, abs)] as const)).then(
      (entries) => alive && setInfos(new Map(entries)),
    );
    return () => {
      alive = false;
    };
    // absPaths 由 signature 概括。
  }, [signature]);
  return infos;
}

/** 图片文件读不到的参考图 / 结果节点 id；读完之前为空（不闪缺图占位）。结果节点的图层文件按 imageKey 分键，与底图互不株连。 */
export function useMissingImages(board: Board, userRoot: string): ReadonlySet<string> {
  const port = useShell();
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const images = board.nodes.flatMap((n) => nodeImages(n, userRoot));
  const signature = JSON.stringify(images);
  useEffect(() => {
    let alive = true;
    void Promise.all(images.map(async ({ key, absPath }) => ((await imageInfoCache.read(port.files.inspectImage, absPath)) ? null : key))).then(
      (ids) => alive && setMissing(new Set(ids.filter((id): id is string => id !== null))),
    );
    return () => {
      alive = false;
    };
    // images 由 signature 概括。
  }, [signature]);
  return missing;
}

// 按路径缓存读到的文件：只交给 storedStatuses 读结局记录——结局记录只写一次，读过就不再读。
// 失败不缓存：401 / 断网恢复后要能重读，否则一次故障就永久显示成已中断。
const fileReads = new Map<string, Promise<Uint8Array>>();
const cachedReadFs = (taskFs: Pick<TaskFs, "readFile">): Pick<TaskFs, "readFile"> => ({
  readFile: (path) => {
    let pending = fileReads.get(path);
    if (!pending) {
      pending = taskFs.readFile(path);
      fileReads.set(path, pending);
      void pending.catch(() => fileReads.delete(path));
    }
    return pending;
  },
});

/** 已中断只在本次运行里首次发现时记一次日志（去重规则见 core/submission.ts 的 createInterruptedLog）。 */
const interruptedLog = createInterruptedLog();

/**
 * 本次运行没经手过、提交过却没有结果的任务的状态（规则在 core/submission.ts 的 storedStatuses）。读完之前不显示徽标。
 */
export function useStoredStatuses(board: Board, boardFile: string, userRoot: string, handled: ReadonlySet<string>): ReadonlyMap<string, NodeRunState> {
  const port = useShell();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, NodeRunState>>(new Map());
  const signature = JSON.stringify([userRoot, boardFile, interruptedCandidates(board, handled)]);
  useEffect(() => {
    let alive = true;
    void storedStatuses(cachedReadFs(port.core.taskFs), board, handled, userRoot, boardFile).then(({ statuses, interruptedEvents }) => {
      for (const event of interruptedLog.take(interruptedEvents)) port.ui.log("task", { ...event });
      if (alive) setStatuses(statuses);
    }, () => {
      // 结局记录读失败（401 / 5xx / 断网）：保持原状态，不虚构「已中断」。下一次签名变化会重试。
    });
    return () => {
      alive = false;
    };
    // board / handled 里与结果相关的部分由 signature 概括。
  }, [signature]);
  return statuses;
}
