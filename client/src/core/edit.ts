// 画板编辑：画板变更的唯一负责方（ADR 0014）。编辑(画板, 画板变更, 环境) → 新画板 + 撤销步 + 提示 + 建议选中。
// 同步、纯：弹确认框、选文件、读图片宽高与 sha 等副作用由界面先做完，把事实放进变更；时钟不进来，撤销步由 sessions 落账。
// 规则都在这里：变更属于哪一类、撤销步描述与归并键（由变更种类决定）、后置管线（图片端口同步 → 自动宽高比）、运行期锁定。
import type { OutputOptions } from "./gateway";
import { isLayerSize, outputOptions } from "./gateway";
import { syncAutoRatios } from "./autoRatio";
import { taskCount, type Board, type BoardEdge, type PortRef, type PromptNode, type Region, type TaskNode } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { attachReferences, newTask } from "./dragCreate";
import { canConnect, connect, disconnect, forkPrompt, moveImagePort, removeNodes, splitReferenceRefusal, syncImagePorts, workflowOf, type Connection } from "./graph";
import { countLabel, MERGE_PAUSE_MS, type UserChange } from "./history";
import { addAsReference, addAsReferenceTarget, continueEditing, LOCKED_HINT, pasteClip, PASTE_OFFSET, type Clip, type Outcome } from "./iterate";
import { addResultNode, PROMPT_NODE_SIZE, type RunResult } from "./layout";
import { IMAGE_NODE_WIDTH, imageNodeSize } from "./nodeSize";
import { setEdgeRegion } from "./region";
import { duplicateNodes, nudgeNodes, settleAltDrag } from "./selection";
import type { Discovery } from "./settings";
import { autoSizeSpec, manualSizeSpec, withSizeTier } from "./size";

type Pos = [number, number];

/** 编辑的只读环境：由 sessions 层按画板组装。 */
export interface EditEnv {
  table: CapabilityTable;
  /** 新建任务、以此继续编辑选默认模型用。 */
  discovery: Discovery;
  /** 本画板排队 / 执行中的任务节点：参数（位置、尺寸除外）与输入连线锁定。 */
  locked: ReadonlySet<string>;
  /** 图片节点 path → 像素 [宽, 高]；还没读到为 undefined。 */
  imageSize: (path: string) => [number, number] | undefined;
  newId: () => string;
}

/** 一条连线的端点（不带区域等可变字段）。 */
export interface EdgeRef {
  from: PortRef;
  to: PortRef;
}

/** 一次拖动：id 每次拖动递增（归并键）；copies = Alt + 拖复制出的节点数，0 = 普通拖动。 */
export interface DragRef {
  id: number;
  copies: number;
}

/** 已读好的参考图文件：path 数据根内为相对路径。 */
export interface ImportedImage {
  path: string;
  sha256: string;
  display_name: string;
  width: number;
  height: number;
  /** 文件字节数：选图当下就能按声明的 max_bytes 拦截（#176）；缺省 = 未知，留给派发前按快照验。 */
  bytes?: number;
}

/**
 * 画板变更：封闭联合类型。用户变更构成撤销步；视图变更（viewport / lastModel / title）与系统变更（submitted / runResult / syncAutoRatios）不构成。
 * 属于哪一类由 kind 决定，调用方不能声明。
 */
export type BoardChange =
  // ---- 用户变更 ----
  /** 拖动（含多选、Alt + 拖）中的位置；drag = null 为拖动之外的单次移动。 */
  | { kind: "move"; moves: [string, Pos][]; drag: DragRef | null }
  /** Alt + 拖松手：原节点回到起点，副本落在松手处。pairs = [原节点, 副本]，starts = 原节点拖动前的位置。 */
  | { kind: "settleDrag"; drag: DragRef; pairs: [string, string][]; starts: [string, Pos][] }
  /** 拖角缩放：box 为新的显示宽高，pos 为从左 / 上角缩放时同批的新位置。resize 每次缩放递增（归并键）。 */
  | { kind: "resize"; resize: number; boxes: { id: string; width: number; height: number; pos: Pos | null }[] }
  | { kind: "nudge"; ids: string[]; delta: Pos }
  /** 复制选中节点：Ctrl+J 原地偏移（drag = null）；Alt + 拖开始时叠在原处（与这次拖动合为一步），副本按复制顺序追加在节点末尾。 */
  | { kind: "duplicate"; ids: string[]; drag: DragRef | null }
  | { kind: "paste"; clip: Clip }
  | { kind: "newPrompt"; at: Pos }
  /** promptId = 从该提示词拖线建节点，接新任务的正向端口。 */
  | { kind: "newTask"; at: Pos; promptId: string | null }
  /** attach = 同时依次接到该任务的空图片端口（拖线建节点 / 文件拖到任务卡片上）；place 见 attachReferences。 */
  | { kind: "addReferences"; images: ImportedImage[]; at: Pos; attach: { taskId: string; place: "asIs" | "left" } | null }
  | { kind: "connect"; connection: Connection }
  /** 删除节点与断开连线；cancelled = 已确认「先取消再删除」的锁定任务（连同取消），豁免锁定。 */
  | { kind: "delete"; nodes: string[]; edges: EdgeRef[]; cancelled: string[] }
  | { kind: "editPrompt"; promptId: string; text: string }
  | { kind: "setTier"; taskId: string; tier: string }
  /** ratio = null 为自动（跟随参考图，同一次变更里算好），否则为手动的具体值。 */
  | { kind: "setRatio"; taskId: string; ratio: string | null }
  | { kind: "setLayerSize"; taskId: string; size: import("./gateway").LayerSize }
  /** 拆分图层的输出张数；范围由能力表该工作流约束，这里只挡非正整数。 */
  | { kind: "setLayerMaxImages"; taskId: string; count: number }
  | { kind: "setOutputOptions"; taskId: string; options: OutputOptions }
  /** 份数：正整数；可选范围（不超过并发上限）由控件约束，核心不按页面设置改写。 */
  | { kind: "setCount"; taskId: string; count: number }
  | { kind: "setTaskFlag"; taskId: string; flag: "layer_decomposition" | "transparent_background" | "layer_text_recognition"; value: boolean }
  /** 切换任务节点的模型，并记为画板最近选择。 */
  | { kind: "setModel"; taskId: string; model: string }
  | { kind: "moveImagePort"; taskId: string; from: number; to: number }
  | { kind: "setRegion"; edge: EdgeRef; region: Region | null }
  /** 编辑已提交过的提示词节点，选「断开并分叉」。 */
  | { kind: "forkPrompt"; promptId: string; text: string }
  /** sourceLayer（1 起）= 触发节点接该图层；at = 新任务左上角（拖线建节点的松手处）。构造见 continueEditingChange。 */
  | { kind: "continueEditing"; sources: string[]; trigger: string; sourceLayer: number | null; at: Pos | null }
  /** 目标任务 = 选区里恰好一个生成任务。 */
  | { kind: "addAsReference"; resultId: string; selected: string[]; sourceLayer: number | null }
  /** 缺图节点重新定位：picked = 用户手选的文件（参考图随之改显示名）；fileName 为新文件名。 */
  | { kind: "relocate"; nodeId: string; path: string; sha256: string; fileName: string; picked: boolean }
  // ---- 视图变更 ----
  | { kind: "viewport"; viewport: Board["viewport"] }
  /** 工具栏的新建任务模型：偏好不是编辑。 */
  | { kind: "lastModel"; model: string }
  | { kind: "title"; title: string }
  // ---- 系统变更 ----
  /** 派发时写入的提交记录。 */
  | { kind: "submitted"; taskId: string; lastSubmitted: TaskNode["last_submitted"] }
  | { kind: "runResult"; result: RunResult }
  /** 图片宽高晚于画板变更读到、或任务解除锁定时补算自动宽高比。 */
  | { kind: "syncAutoRatios" };

export type ChangeClass = "user" | "system" | "view";

const VIEW = new Set<BoardChange["kind"]>(["viewport", "lastModel", "title"]);
const SYSTEM = new Set<BoardChange["kind"]>(["submitted", "runResult", "syncAutoRatios"]);

export function changeClass(change: BoardChange): ChangeClass {
  return VIEW.has(change.kind) ? "view" : SYSTEM.has(change.kind) ? "system" : "user";
}

export interface EditResult {
  board: Board;
  /** 要落账的撤销步：只有用户变更且画板确实变了才有。 */
  step: UserChange | null;
  /** 要告诉用户的话（被拒的原因、删除后的撤销提示）。 */
  hint?: string;
  /** 变更后建议选中的节点。 */
  selection?: string[];
}

/** 以此继续编辑的变更：拖线建节点（带 at）只接拖出的这一张；右键菜单 / 节点按钮 / 预览发起时，触发节点在选区内则沿用多选。 */
export function continueEditingChange(selected: ReadonlySet<string>, nodeId: string, sourceLayer: number | null = null, at: Pos | null = null): BoardChange {
  return { kind: "continueEditing", sources: !at && selected.has(nodeId) ? [...selected] : [nodeId], trigger: nodeId, sourceLayer, at };
}

/** 各变更算出的草稿：用户变更带撤销步描述。 */
interface Draft {
  board: Board;
  step?: UserChange;
  hint?: string;
  selection?: string[];
}

const mapNodes = (board: Board, fn: (n: Board["nodes"][number]) => Board["nodes"][number]): Board => {
  let changed = false;
  const nodes = board.nodes.map((n) => {
    const next = fn(n);
    if (next !== n) changed = true;
    return next;
  });
  return changed ? { ...board, nodes } : board;
};

const mapTask = (board: Board, taskId: string, fn: (t: TaskNode) => TaskNode): Board => mapNodes(board, (n) => (n.id === taskId && n.type === "task" ? fn(n) : n));

const samePos = (a: Pos, b: Pos) => a[0] === b[0] && a[1] === b[1];
const round = (p: Pos): Pos => [Math.round(p[0]), Math.round(p[1])];

const sameRef = (e: BoardEdge, r: EdgeRef) => e.from[0] === r.from[0] && e.from[1] === r.from[1] && e.to[0] === r.to[0] && e.to[1] === r.to[1];

/** Outcome → 草稿：被拒时画板不动、带原因。 */
const fromOutcome = (board: Board, r: Outcome, step: UserChange, selection?: string[]): Draft =>
  r.ok ? { board: r.board, step, selection } : { board, hint: r.reason };

function sizeRuleOf(board: Board, table: CapabilityTable, task: TaskNode) {
  return findModel(table, task.model)?.workflows[workflowOf(board, task.id)].size_rule;
}

// ---- 变更处理：一个种类一项，按类别分组 ----
// 分支多的单独一个函数；只是改一个字段、一句话能说清的，按类别合成一个 switch（每个函数都在 10 以内）。

/** 某一变更种类（或几种）的收窄类型：处理函数只认自己那几种。 */
type ChangeOf<K extends BoardChange["kind"]> = Extract<BoardChange, { kind: K }>;

/** 一种变更的处理函数：change 已按 kind 收窄。 */
type Handler<K extends BoardChange["kind"]> = (board: Board, change: ChangeOf<K>, env: EditEnv) => Draft;

/** 查表分发用的表：每个变更种类一项，一项都不许少（用户、视图、系统变更都走这里）。 */
type DraftHandlers = { [K in BoardChange["kind"]]: Handler<K> };

// ---- 拖动与复制 ----

/** 取整后换到新位置；位置没变的节点不动（画板换不换由 mapNodes 判断）。 */
const mapMoved = (board: Board, moves: Map<string, Pos>): Board =>
  mapNodes(board, (n) => {
    const p = n.type !== "unknown" && moves.get(n.id);
    return p && !samePos(n.pos, round(p)) ? { ...n, pos: round(p) } : n;
  });

function moveDraft(board: Board, change: ChangeOf<"move">): Draft {
  const moves = new Map(change.moves);
  const next = mapMoved(board, moves);
  const { drag } = change;
  const label = drag?.copies ? countLabel("复制", drag.copies) : countLabel("移动", moves.size);
  return { board: next, step: drag ? { label, merge: { key: `drag:${drag.id}` } } : { label } };
}

function settleDragDraft(board: Board, change: ChangeOf<"settleDrag">): Draft {
  const next = settleAltDrag(board, change.pairs, new Map(change.starts));
  return { board: next, step: { label: countLabel("复制", change.pairs.length), merge: { key: `drag:${change.drag.id}` } }, selection: change.pairs.map(([, copy]) => copy) };
}

/** 按显示宽高重算尺寸；从左上角缩放时连位置一起换，位置与尺寸都没变的不动。 */
const mapResized = (board: Board, boxes: Map<string, { id: string; width: number; height: number; pos: Pos | null }>): Board =>
  mapNodes(board, (n) => {
    const box = boxes.get(n.id);
    if (!box || n.type === "unknown") return n;
    const pos = box.pos ? round(box.pos) : n.pos;
    const size = imageNodeSize(box.width, box.height / box.width);
    return samePos(pos, n.pos) && samePos(size, n.size) ? n : { ...n, pos, size };
  });

function resizeDraft(board: Board, change: ChangeOf<"resize">): Draft {
  const boxes = new Map(change.boxes.map((b) => [b.id, b]));
  const next = mapResized(board, boxes);
  return { board: next, step: { label: countLabel("缩放", boxes.size), merge: { key: `resize:${change.resize}` } } };
}

function nudgeDraft(board: Board, change: ChangeOf<"nudge">): Draft {
  const ids = [...change.ids].sort();
  return { board: nudgeNodes(board, ids, change.delta), step: { label: countLabel("微移", ids.length), merge: { key: `nudge:${ids.join(",")}`, windowMs: MERGE_PAUSE_MS } } };
}

function duplicateDraft(board: Board, change: ChangeOf<"duplicate">, env: EditEnv): Draft {
  const { drag } = change;
  const r = duplicateNodes(board, change.ids, env.newId, drag ? 0 : PASTE_OFFSET);
  if (!r.pairs.length) return { board };
  const label = countLabel("复制", r.pairs.length);
  // Alt + 拖进行中选区不动（拖的仍是原节点），松手对调后才选中副本（settleDrag）。
  return drag ? { board: r.board, step: { label, merge: { key: `drag:${drag.id}` } } } : { board: r.board, step: { label }, selection: r.ids };
}

function pasteDraft(board: Board, change: ChangeOf<"paste">, env: EditEnv): Draft {
  if (!change.clip.nodes.length) return { board };
  const r = pasteClip(board, change.clip, env.newId);
  return { board: r.board, step: { label: countLabel("粘贴", change.clip.nodes.length) }, selection: r.ids };
}

// ---- 节点增删与重新定位 ----

function newPromptDraft(board: Board, change: ChangeOf<"newPrompt">, env: EditEnv): Draft {
  const node: PromptNode = { type: "prompt", id: env.newId(), pos: round(change.at), size: PROMPT_NODE_SIZE, text: "", extra: {} };
  return { board: { ...board, nodes: [...board.nodes, node] }, step: { label: "新建提示词" }, selection: [node.id] };
}

function newTaskDraft(board: Board, change: ChangeOf<"newTask">, env: EditEnv): Draft {
  const id = env.newId();
  return fromOutcome(board, newTask(board, env.table, env.discovery, id, round(change.at), change.promptId ?? undefined), { label: "新建生成任务" }, [id]);
}

/** 逐张错开落点、尺寸按图片宽高算；id 按导入顺序取。 */
const referenceNodes = (images: ImportedImage[], at: Pos, env: EditEnv) =>
  images.map((img, i) => ({
    type: "reference" as const,
    id: env.newId(),
    pos: round([at[0] + 32 * i, at[1] + 32 * i]),
    size: imageNodeSize(IMAGE_NODE_WIDTH, img.width > 0 ? img.height / img.width : 1),
    path: img.path,
    sha256: img.sha256,
    display_name: img.display_name,
    extra: {},
  }));

function addReferencesDraft(board: Board, change: ChangeOf<"addReferences">, env: EditEnv): Draft {
  if (!change.images.length) return { board };
  // 拆分场景就地拦截（#176）：不合规就不落节点、不接线，只说明原因。
  const refusal = change.attach ? splitReferenceRefusal(board, env.table, change.attach.taskId, change.images) : null;
  if (refusal !== null) return { board, hint: refusal };
  const nodes = referenceNodes(change.images, change.at, env);
  const step = { label: countLabel("添加", nodes.length, "张参考图") };
  const selection = [nodes[nodes.length - 1].id];
  if (!change.attach) return { board: { ...board, nodes: [...board.nodes, ...nodes] }, step, selection };
  // 导入不因接不上而丢：节点总是加上，接不上时带原因（锁定任务不接线）。
  const r = attachReferences(board, env.table, nodes, change.attach.taskId, env.locked, change.attach.place);
  return { board: r.board, step, selection, hint: r.reason ?? undefined };
}

function connectDraft(board: Board, change: ChangeOf<"connect">, env: EditEnv): Draft {
  if (!canConnect(board, env.table, change.connection).ok) return { board };
  // 提示词连正向 / 负向即确定其角色；角色由连线端口体现，无需另存字段。
  return { board: { ...board, edges: connect(board, change.connection) }, step: { label: "连线" } };
}

function deleteDraft(board: Board, change: ChangeOf<"delete">): Draft {
  const cut = board.edges.filter((e) => !e.system && change.edges.some((r) => sameRef(e, r)));
  let next = cut.length ? { ...board, edges: disconnect(board, cut) } : board;
  if (!change.nodes.length) return { board: next, step: { label: countLabel("断开", change.edges.length, "条连线") } };
  const removal = removeNodes(next, change.nodes);
  next = removal.board;
  const removed = removal.removedIds.length;
  return {
    board: next,
    step: { label: countLabel("删除", removed) },
    hint: `已删除 ${removed} 个节点${removal.severed ? `、断开 ${removal.severed} 条连线` : ""}，Ctrl+Z 撤销`,
    selection: [],
  };
}

/** 换文件：参考图换了文件即换了身份（哈希变了，下游任务随之变脏）；结果的身份是 task_id + 文件名，只改路径。 */
const relocated = (n: Board["nodes"][number], change: ChangeOf<"relocate">): Board["nodes"][number] => {
  if (n.id !== change.nodeId) return n;
  if (n.type === "reference") return { ...n, path: change.path, sha256: change.sha256, display_name: change.picked ? change.fileName : n.display_name };
  return n.type === "result" ? { ...n, path: change.path } : n;
};

function relocateDraft(board: Board, change: ChangeOf<"relocate">): Draft {
  return { board: mapNodes(board, (n) => relocated(n, change)), step: { label: "重新定位图片" } };
}

// ---- 提示词与派生 ----

function editPromptDraft(board: Board, change: ChangeOf<"editPrompt">): Draft {
  const next = mapNodes(board, (n) => (n.id === change.promptId && n.type === "prompt" && n.text !== change.text ? { ...n, text: change.text } : n));
  return { board: next, step: { label: "编辑提示词", merge: { key: `text:${change.promptId}`, windowMs: MERGE_PAUSE_MS } } };
}

function forkPromptDraft(board: Board, change: ChangeOf<"forkPrompt">, env: EditEnv): Draft {
  return { board: forkPrompt(board, change.promptId, { newNodeId: env.newId(), text: change.text }), step: { label: "分叉提示词" } };
}

function continueEditingDraft(board: Board, change: ChangeOf<"continueEditing">, env: EditEnv): Draft {
  const ids = { taskId: env.newId(), promptId: env.newId() };
  const layers = change.sourceLayer === null ? null : new Map([[change.trigger, change.sourceLayer]]);
  const r = continueEditing(board, env.table, env.discovery, change.sources, change.trigger, ids, layers, change.at && round(change.at));
  return fromOutcome(board, r, { label: "以此继续编辑" }, [ids.promptId]);
}

function addAsReferenceDraft(board: Board, change: ChangeOf<"addAsReference">, env: EditEnv): Draft {
  const target = addAsReferenceTarget(board, change.selected);
  if (!target.ok) return { board, hint: target.reason };
  return fromOutcome(board, addAsReference(board, env.table, change.resultId, target.taskId, change.sourceLayer), { label: "加为参考图" });
}

// ---- 任务参数：尺寸与输出、份数与开关、模型与连线 ----

function sizeDraft(board: Board, change: ChangeOf<"setTier" | "setRatio">, env: EditEnv): Draft {
  switch (change.kind) {
    case "setTier":
      return {
        board: mapTask(board, change.taskId, (t) => {
          const rule = sizeRuleOf(board, env.table, t);
          return rule ? { ...t, size_spec: withSizeTier(rule, t.size_spec, change.tier) } : t;
        }),
        step: { label: "修改尺寸" },
      };
    case "setRatio":
      return {
        board: mapTask(board, change.taskId, (t) => {
          if (change.ratio !== null) return { ...t, size_spec: manualSizeSpec(t.size_spec, change.ratio) };
          const rule = sizeRuleOf(board, env.table, t);
          // 先标为自动，具体值由后置管线在同一次变更里按参考图算好。
          return rule ? { ...t, size_spec: autoSizeSpec(rule, t.size_spec.tier, null, null, t.size_spec) } : t;
        }),
        step: { label: "修改尺寸" },
      };
  }
}

function layerDraft(board: Board, change: ChangeOf<"setLayerSize" | "setOutputOptions" | "setLayerMaxImages">): Draft {
  switch (change.kind) {
    case "setLayerSize":
      if (!isLayerSize(change.size)) return { board };
      return { board: mapTask(board, change.taskId, (t) => ({ ...t, layer_size: change.size })), step: { label: "修改图层尺寸" } };
    case "setLayerMaxImages":
      if (!Number.isInteger(change.count) || change.count < 1) return { board };
      return { board: mapTask(board, change.taskId, (t) => (t.layer_max_images === change.count ? t : { ...t, layer_max_images: change.count })), step: { label: "修改图层数量" } };
    case "setOutputOptions":
      return { board: mapTask(board, change.taskId, (t) => ({ ...t, output_options: outputOptions(change.options) })), step: { label: "修改输出选项" } };
  }
}

/** 画板开关的中文说法：撤销步与界面同一个词。 */
const TASK_FLAG_LABELS: Record<"layer_decomposition" | "transparent_background" | "layer_text_recognition", string> = {
  layer_decomposition: "切换图层拆分",
  transparent_background: "切换透明背景",
  layer_text_recognition: "切换文字识别",
};

function countDraft(board: Board, change: ChangeOf<"setCount" | "setTaskFlag">): Draft {
  switch (change.kind) {
    case "setCount":
      if (!Number.isInteger(change.count) || change.count < 1) return { board };
      return { board: mapTask(board, change.taskId, (t) => (taskCount(t) === change.count ? t : { ...t, count: change.count })), step: { label: "修改份数" } };
    case "setTaskFlag":
      return {
        board: mapTask(board, change.taskId, (t) => (t[change.flag] === change.value ? t : { ...t, [change.flag]: change.value })),
        step: { label: TASK_FLAG_LABELS[change.flag] },
      };
  }
}

function modelDraft(board: Board, change: ChangeOf<"setModel">): Draft {
  const next = mapTask(board, change.taskId, (t) => (t.model === change.model ? t : { ...t, model: change.model }));
  return { board: next === board ? board : { ...next, last_model: change.model }, step: { label: "切换模型" } };
}

function edgeDraft(board: Board, change: ChangeOf<"moveImagePort" | "setRegion">): Draft {
  switch (change.kind) {
    case "moveImagePort": {
      const edges = moveImagePort(board, change.taskId, change.from, change.to);
      return { board: edges === board.edges ? board : { ...board, edges }, step: { label: "调整图片顺序" } };
    }
    case "setRegion":
      if (!board.edges.some((e) => sameRef(e, change.edge))) return { board };
      return { board: setEdgeRegion(board, change.edge, change.region), step: { label: change.region ? "框选修改区域" : "清除修改区域" } };
  }
}

// ---- 视图与系统 ----

const sameViewport = (a: Board["viewport"], b: Board["viewport"]) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

function viewDraft(board: Board, change: ChangeOf<"viewport" | "lastModel" | "title">): Draft {
  switch (change.kind) {
    case "viewport": {
      const { x, y, zoom } = change.viewport;
      return { board: sameViewport(board.viewport, change.viewport) ? board : { ...board, viewport: { x, y, zoom } } };
    }
    case "lastModel":
      return { board: board.last_model === change.model ? board : { ...board, last_model: change.model } };
    case "title":
      return { board: board.title === change.title ? board : { ...board, title: change.title } };
  }
}

function systemDraft(board: Board, change: ChangeOf<"submitted" | "runResult" | "syncAutoRatios">, env: EditEnv): Draft {
  switch (change.kind) {
    case "submitted":
      return { board: mapTask(board, change.taskId, (t) => ({ ...t, last_submitted: change.lastSubmitted })) };
    case "runResult":
      return { board: addResultNode(board, { ...change.result, id: env.newId() }) };
    case "syncAutoRatios":
      return { board };
  }
}

/** 变更种类 → 处理函数：分发只查这张表。 */
const HANDLERS: DraftHandlers = {
  move: moveDraft,
  settleDrag: settleDragDraft,
  resize: resizeDraft,
  nudge: nudgeDraft,
  duplicate: duplicateDraft,
  paste: pasteDraft,
  newPrompt: newPromptDraft,
  newTask: newTaskDraft,
  addReferences: addReferencesDraft,
  connect: connectDraft,
  delete: deleteDraft,
  relocate: relocateDraft,
  editPrompt: editPromptDraft,
  forkPrompt: forkPromptDraft,
  continueEditing: continueEditingDraft,
  addAsReference: addAsReferenceDraft,
  setTier: sizeDraft,
  setRatio: sizeDraft,
  setLayerSize: layerDraft,
  setLayerMaxImages: layerDraft,
  setOutputOptions: layerDraft,
  setCount: countDraft,
  setTaskFlag: countDraft,
  setModel: modelDraft,
  moveImagePort: edgeDraft,
  setRegion: edgeDraft,
  viewport: viewDraft,
  lastModel: viewDraft,
  title: viewDraft,
  submitted: systemDraft,
  runResult: systemDraft,
  syncAutoRatios: systemDraft,
};

/** 一次变更的草稿：查表分发（每个变更种类在 HANDLERS 里各有一项）。 */
function draft(board: Board, change: BoardChange, env: EditEnv): Draft {
  const handler = HANDLERS[change.kind] as (board: Board, change: BoardChange, env: EditEnv) => Draft;
  return handler(board, change, env);
}


/** 后置管线：图片端口同步 → 自动宽高比重算（锁定任务不动）。无变化时返回原画板。 */
function settle(board: Board, env: EditEnv): Board {
  const synced = syncImagePorts(board);
  const dims = (nodeId: string) => {
    const node = synced.nodes.find((n) => n.id === nodeId);
    return node?.type === "reference" || node?.type === "result" ? env.imageSize(node.path) : undefined;
  };
  return syncAutoRatios(synced, env.table, dims, env.locked);
}

/**
 * 锁定任务对外可见的面：参数（位置、尺寸除外）与输入连线。
 * 提示词在提交时已固化进快照，输入连线里只看它接在哪个端口（分叉换了提示词节点不算改输入）；图片连线按来源、图层与区域比对。
 */
function lockedFace(board: Board, task: TaskNode): string {
  const { pos: _pos, size: _size, ...params } = task;
  const inputs = board.edges
    .filter((e) => e.to[0] === task.id && !e.system)
    .map((e) => (board.nodes.find((n) => n.id === e.from[0])?.type === "prompt" ? [e.to[1], "prompt"] : [e.to[1], e.from, e.source_layer, e.region]))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([params, inputs]);
}

/** 运行期锁定（后置不变量）：任一锁定任务被删、参数或输入连线变了即违反；exempt = 连同取消的任务。 */
function violatesLock(before: Board, after: Board, locked: ReadonlySet<string>, exempt: ReadonlySet<string>): boolean {
  for (const id of locked) {
    if (exempt.has(id)) continue;
    const was = before.nodes.find((n) => n.id === id);
    if (was?.type !== "task") continue;
    const now = after.nodes.find((n) => n.id === id);
    if (now?.type !== "task" || lockedFace(before, was) !== lockedFace(after, now)) return true;
  }
  return false;
}

/** 草稿里要带出去的提示：没话要说就不带这个字段。 */
const hintOf = (d: Draft) => (d.hint !== undefined ? { hint: d.hint } : {});

/** 草稿里要带出去的提示与建议选中：视图 / 系统变更也照带。 */
const extrasOf = (d: Draft) => ({ ...hintOf(d), ...(d.selection ? { selection: d.selection } : {}) });

/** 分类之后的下半段：后置管线 → 锁定校验 → 落撤销步。 */
function finishEdit(board: Board, change: BoardChange, cls: ChangeClass, d: Draft, env: EditEnv): EditResult {
  const extras = extrasOf(d);
  const next = settle(d.board, env);
  if (next === board) return { board, step: null, ...extras };
  if (cls === "system") return { board: next, step: null, ...extras };
  const exempt = new Set(change.kind === "delete" ? change.cancelled : []);
  if (violatesLock(board, next, env.locked, exempt)) return { board, step: null, hint: LOCKED_HINT };
  return { board: next, step: d.step ?? null, ...extras };
}

/** 应用一次画板变更。被拒或无变化时返回原画板（同一引用）、撤销步为 null。 */
export function editBoard(board: Board, change: BoardChange, env: EditEnv): EditResult {
  const cls = changeClass(change);
  const d = draft(board, change, env);
  if (cls === "view") return { board: d.board, step: null, ...extrasOf(d) };
  // 用户变更本身没改动（被拒、落点无效）就不跑管线，免得把无关的补算记成这一步。
  if (cls === "user" && d.board === board) return { board, step: null, ...hintOf(d) };
  return finishEdit(board, change, cls, d, env);
}
