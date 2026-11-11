// 画布节点：画板文件模型逐条展开成 React Flow 的节点数据（四型各自的 data、图片尺寸与类名）。
// 只做派生，不写盘；画布组件把状态接线成 CanvasNodeInput，这里只按事实算出节点。
import type { Node } from "@xyflow/react";
import type { Board, BoardNode, PromptNode, ReferenceNode, ResultNode, TaskNode } from "../core/board";
import { findModel, type CapabilityTable, type InputImageRule } from "../core/capabilities";
import { menuItems, type MenuFacts } from "../core/contextMenu";
import {
  firstRegionOfEdge,
  hasDownstreamRecords,
  imageEdges,
  imagePortIndex,
  imagePortSlots,
  inputRuleModels,
  taskPorts,
  workflowOf,
} from "../core/graph";
import { renderedImageSize } from "../core/nodeSize";
import { resolveFromRoot } from "../core/paths";
import { nodeClassName, promptPortKind, type DragState } from "../core/ports";
import { effectiveRegionRender, type PortSlot } from "../core/region";
import type { TaskStatus } from "../core/run";
import { nodeCopyDetail, nodeSummary, summaryTone, type NodeRunState } from "../core/runner";
import { defaultTaskModel, type Discovery } from "../core/settings";
import { taskView } from "../core/taskView";
import type { ImageInfo } from "../shell/ipc";
import type { ImagePortInfo, ImageSlotInfo, PromptReferenceGuideTask } from "./nodes";

/** 尚未回传测量结果的节点：非空即可让 React Flow 保留内部已测得的 handleBounds（见 baseNodeOf 的 measured）。 */
const NOT_MEASURED: { width?: number; height?: number } = {};

/** 画布节点派生要用的画板、能力表与界面采集的事实（状态都在画布组件里，这里只读）。 */
export interface CanvasNodeInput {
  board: Board;
  table: CapabilityTable;
  userRoot: string;
  /** 当前选中的节点。 */
  selected: ReadonlySet<string>;
  /** React Flow 回传的实测尺寸；还没有的不在表里。 */
  measured: Readonly<Record<string, { width?: number; height?: number }>>;
  /** 收起的阶段里的成员节点：React Flow 连同其连线一起隐藏。 */
  hidden: ReadonlySet<string>;
  /** 谱系高亮：选中任一点时其上下游节点（见 core/iterate 的 lineage）。 */
  lineageNodes: ReadonlySet<string>;
  /** 拖线态；未拖线为 null。 */
  drag: DragState | null;
  /** 「以此继续编辑」的一次性聚焦请求：命中的提示词节点自己取走。 */
  focusPrompt: string | null;
  /** 提示词等待三选一的未提交文本（画布保管）。 */
  promptDrafts: ReadonlyMap<string, string>;
  /** 图片文件读不到的节点 / 图层键。 */
  missing: ReadonlySet<string>;
  /** 图片绝对路径 → 读到的图片信息；未读到或读不出为 null / 不在表里。 */
  imageInfos: ReadonlyMap<string, ImageInfo | null>;
  /** 节点 id → 是否带透明通道；不在 Map 里 = 未知。 */
  alphaByNode: ReadonlyMap<string, boolean>;
  discovery: Discovery;
  /** 页面当前的并发上限：份数控件的可选上界。 */
  concurrency: number;
  /** 设置原地展开的任务节点。 */
  expanded: ReadonlySet<string>;
  /** 排队 / 执行中的任务节点：参数与连线锁定。 */
  locked: ReadonlySet<string>;
  runStateOf: (taskId: string) => NodeRunState | undefined;
  statusOf: (taskId: string) => TaskStatus | null;
  /** 菜单事实（运行按钮与上下文菜单同一条目、同一置灰原因）。 */
  menuFacts: (selected: ReadonlySet<string>) => MenuFacts;
}

/** 四类节点共用的 React Flow 字段：位置、选中、隐藏、测量回传与类名。 */
type NodeBase = Pick<Node, "id" | "position" | "selected" | "hidden" | "measured" | "className">;

/** 画布上真的画出来的节点：本版本不认识的类型没有位置（也永远不渲染）。 */
type PlacedNode = Exclude<BoardNode, { type: "unknown" }>;

/** 图片端口来源：参考图与结果节点各自的标签与绝对路径；源节点不存在时标签为「?」、没有路径。 */
function labelOf(input: CanvasNodeInput, id: string): ImagePortInfo {
  const src = input.board.nodes.find((n) => n.id === id);
  if (src?.type === "reference") return { label: src.display_name, absPath: resolveFromRoot(input.userRoot, src.path) };
  if (src?.type === "result") return { label: src.file, absPath: resolveFromRoot(input.userRoot, src.path) };
  return { label: "?", absPath: null };
}

/** 提示词连向任务的正向 / 负向端口：只有这两种线进「图N」引导。 */
function isPromptPortEdge(edge: { from: [string, string]; to: [string, string] }, promptId: string): boolean {
  return edge.from[0] === promptId && (edge.to[1] === "positive" || edge.to[1] === "negative");
}

/** 某任务接了哪些图片（按端口升序）：「图N」的序号与来源标签；读不到路径的来源不成为条目（叠加图不可点）。 */
function guideImagesOf(input: CanvasNodeInput, taskId: string): PromptReferenceGuideTask["images"] {
  return imageEdges(input.board, taskId).flatMap((imageEdge, index) => {
    const info = labelOf(input, imageEdge.from[0]);
    return info.absPath ? [{ port: index + 1, label: info.label, absPath: info.absPath, rects: imageEdge.region?.rects ?? [] }] : [];
  });
}

/** 提示词节点的「图N」引导：直接下游任务逐个列出（同一任务只算一次），没有可点条目的任务不出现。 */
function promptGuidesOf(input: CanvasNodeInput, promptId: string): PromptReferenceGuideTask[] {
  const groups: PromptReferenceGuideTask[] = [];
  const taskIds = new Set<string>();
  for (const promptEdge of input.board.edges) {
    if (!isPromptPortEdge(promptEdge, promptId)) continue;
    const task = input.board.nodes.find((n) => n.id === promptEdge.to[0]);
    if (task?.type !== "task" || taskIds.has(task.id)) continue;
    taskIds.add(task.id);
    const modelName = findModel(input.table, task.model)?.display_name ?? task.model;
    const images = guideImagesOf(input, task.id);
    if (images.length > 0) groups.push({ taskId: task.id, label: modelName, images });
  }
  return groups;
}

/** 图片节点的输入规则提示：接了任务按下游任务的模型，未接线的参考图按新建任务会用的默认模型。 */
function rulesOf(input: CanvasNodeInput, id: string): InputImageRule[] {
  const fallbackModel = defaultTaskModel(input.table, input.discovery, input.board.last_model);
  return inputRuleModels(input.board, id, fallbackModel).flatMap((m) => findModel(input.table, m)?.input_image_rule ?? []);
}

/** 图片节点按存的宽度与图片比例显示（不回写 size）；缺图时高度随占位内容。 */
function imageBox(input: CanvasNodeInput, n: ReferenceNode | ResultNode): { width: number; height?: number } {
  const [width, height] = renderedImageSize(n.size, input.imageInfos.get(resolveFromRoot(input.userRoot, n.path)));
  return input.missing.has(n.id) ? { width } : { width, height };
}

/** 四类节点共用的字段：位置、选中、隐藏、测量回传与类名（谱系 / 去强调 / 拖线态）。 */
function baseNodeOf(input: CanvasNodeInput, n: PlacedNode): NodeBase {
  return {
    id: n.id,
    position: { x: n.pos[0], y: n.pos[1] },
    selected: input.selected.has(n.id),
    // 收起的阶段里的节点：React Flow 连同其连线一起隐藏。
    hidden: input.hidden.has(n.id),
    // 承重逻辑（xyflow#3816）：开启 onlyRenderVisibleElements 后，React Flow 只强制渲染还没有 handleBounds（未测量）的节点。
    // 重建的节点不带 measured 时，adoptUserNodes 会清空已测得的 handleBounds，节点（含视口外的）被重新强制渲染、连线闪断；
    // 还没回传到这里的（刚测完、setMeasured 未提交）也要带一个空对象，否则这次重建清空后不会再测，节点永远留在 DOM 中。
    measured: input.measured[n.id] ?? NOT_MEASURED,
    className: nodeClassName(n.id, { lineage: input.lineageNodes.has(n.id), selecting: input.selected.size > 0, drag: input.drag }) || undefined,
  };
}

/** 提示词节点：下游有已提交过的任务时编辑三选一；聚焦请求、未提交草稿与输出端口色都由画布状态给。 */
function promptNodeOf(input: CanvasNodeInput, n: PromptNode): Node {
  return {
    ...baseNodeOf(input, n),
    type: "prompt",
    data: {
      node: n,
      recorded: hasDownstreamRecords(input.board, n.id),
      autoFocus: input.focusPrompt === n.id,
      draft: input.promptDrafts.get(n.id) ?? null,
      portKind: promptPortKind(input.board, n.id),
      guides: promptGuidesOf(input, n.id),
    },
  };
}

/** 结果节点：结果回灌到任务上才按下游模型规则提示；没接任务不提示。 */
function resultNodeOf(input: CanvasNodeInput, n: ResultNode): Node {
  return { ...baseNodeOf(input, n), ...imageBox(input, n), type: "result", data: { node: n, rules: rulesOf(input, n.id), missing: input.missing.has(n.id) } };
}

/** 参考图节点：没接任务时按新建任务会用的默认模型提示。 */
function referenceNodeOf(input: CanvasNodeInput, n: ReferenceNode): Node {
  return { ...baseNodeOf(input, n), ...imageBox(input, n), type: "reference", data: { node: n, rules: rulesOf(input, n.id), missing: input.missing.has(n.id) } };
}

/** 端口行：图片槽带来源标签与区域事实，叠加锁定行从属原图、没有自己的连线。 */
function slotOf(input: CanvasNodeInput, taskId: string, s: PortSlot): ImageSlotInfo {
  const src = labelOf(input, s.edge.from[0]);
  if (s.kind === "overlay") return { kind: "overlay", port: s.port, userPort: s.userPort, label: src.label, absPath: null, handleIndex: null, rects: [], firstRegion: 0, edgeRef: null };
  return {
    kind: "image",
    port: s.port,
    userPort: s.userPort,
    label: src.label,
    absPath: src.absPath,
    handleIndex: imagePortIndex(s.edge.to[1]),
    rects: s.edge.region?.rects ?? [],
    firstRegion: firstRegionOfEdge(input.board, taskId, s.edge.to[1]),
    edgeRef: { from: s.edge.from, to: s.edge.to },
  };
}

/** 生成任务节点：端口、任务视图、锁定、工作流、端口槽、区域渲染、状态摘要、展开与运行按钮（与菜单同一条目）。 */
function taskNodeOf(input: CanvasNodeInput, n: TaskNode): Node {
  // 节点用缓存事实；运行前 App 逐张重新探测，同样的事实得出同样的原因。
  const view = taskView(input.board, input.table, n.id, { missingNodes: input.missing, alphaByNode: input.alphaByNode, discovery: input.discovery, concurrency: input.concurrency })!;
  const render = effectiveRegionRender(findModel(input.table, n.model));
  const runState = input.runStateOf(n.id);
  const summary = nodeSummary(runState);
  const slots: ImageSlotInfo[] = imagePortSlots(input.board, input.table, n.id).map((s) => slotOf(input, n.id, s));
  return {
    ...baseNodeOf(input, n),
    type: "task",
    data: {
      node: n,
      ports: taskPorts(input.board, input.table, n.id),
      view,
      locked: input.locked.has(n.id),
      workflow: workflowOf(input.board, n.id),
      slots,
      regionRender: render,
      hasPositive: input.board.edges.some((e) => e.to[0] === n.id && e.to[1] === "positive"),
      status: input.statusOf(n.id),
      summary: summary && runState ? { text: summary, detail: nodeCopyDetail(runState), tone: summaryTone(runState.counts) } : null,
      expanded: input.expanded.has(n.id),
      run: menuItems({ kind: "node", nodeId: n.id }, input.menuFacts(new Set([n.id]))).find((i) => i.action === "run")!,
    },
  };
}

/** 单个画板节点：本版本不认识的类型整条原样保留在画板文件里，不渲染。 */
function nodeOf(input: CanvasNodeInput, n: BoardNode): Node[] {
  if (n.type === "unknown") return [];
  switch (n.type) {
    case "prompt":
      return [promptNodeOf(input, n)];
    case "result":
      return [resultNodeOf(input, n)];
    case "reference":
      return [referenceNodeOf(input, n)];
    case "task":
      return [taskNodeOf(input, n)];
  }
}

/** 画布节点列表：顺序与画板节点一致，未知类型不出现。 */
export function canvasNodes(input: CanvasNodeInput): Node[] {
  return input.board.nodes.flatMap((n) => nodeOf(input, n));
}
