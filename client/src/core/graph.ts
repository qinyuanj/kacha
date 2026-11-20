// 节点图规则：连线合法性、任务节点按能力露出的端口与开关、提示词与图片来源。
// 全部是 Board → 结果的纯函数；换模型绝不自动删线或改设置。不可运行原因见 taskView。
import { findTask, type Board, type BoardEdge, type BoardNode, type LayerRecord, type ResultRecord, type TaskNode } from "./board";
import {
  findModel,
  inputImageRuleOf,
  isSupported,
  maxReferencesOf,
  workflowFor,
  type CapabilityTable,
  type InputImageRule,
  type InputScene,
  type WorkflowName,
} from "./capabilities";
import { resolveFromRoot } from "./paths";
import type { ReferenceSource } from "./taskDir";
import { expandImageEdges, type PortSlot } from "./region";
import { imageFormatOf, imageRuleViolations } from "./imageRule";

export const IMAGE_PORT_PREFIX = "image:";

export interface Connection {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const no = (reason: string): Verdict => ({ ok: false, reason });

export function imagePortIndex(handle: string): number | null {
  if (!handle.startsWith(IMAGE_PORT_PREFIX)) return null;
  const index = Number(handle.slice(IMAGE_PORT_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** 某任务节点的图片连线，按端口序号升序（= 参考图序号）。 */
export function imageEdges(board: Board, taskId: string): BoardEdge[] {
  return board.edges
    .filter((e) => e.to[0] === taskId && imagePortIndex(e.to[1]) !== null)
    .sort((a, b) => imagePortIndex(a.to[1])! - imagePortIndex(b.to[1])!);
}

/** 该图片线第一个区域的区域编号（0 起）：排在它前面的图片线上的区域都先编号。 */
export function firstRegionOfEdge(board: Board, taskId: string, toPort: string): number {
  const index = imagePortIndex(toPort) ?? 0;
  return imageEdges(board, taskId)
    .filter((e) => imagePortIndex(e.to[1])! < index)
    .reduce((n, e) => n + (e.region?.rects.length ?? 0), 0);
}

/** 工作流由连线推导：图片端口 0 条线 = 文生图，≥1 条 = 图片编辑。 */
export function workflowOf(board: Board, taskId: string): WorkflowName {
  return workflowFor(imageEdges(board, taskId).length);
}

/** 任务的图片连线按当前模型渲染方式展开后的槽位（区域叠加图紧随原图，占发送序名额）。 */
export function imagePortSlots(board: Board, table: CapabilityTable, taskId: string): PortSlot[] {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  return expandImageEdges(imageEdges(board, taskId), model);
}

/**
 * 链式编辑（#177）：本任务的图片输入里有结果节点的输出，即这一轮的输入是上一轮的结果。
 * 多轮一致性的默认值按它判断：请求体默认 background: opaque，发送文本自动带上「保持未编辑区域完全不变」。
 */
export function chainedEdit(board: Board, taskId: string): boolean {
  return imageEdges(board, taskId).some((e) => board.nodes.find((n) => n.id === e.from[0])?.type === "result");
}

/**
 * 同一判定的任务记录来源：重新生成 / 生成变体不看画板当前内容，改看那次提交的参考图来源。
 * 叠加图由它的原图代表（task.json 里两个来源各记一条），所以只看有没有结果是充分的。
 */
export function chainedSubmission(references: readonly { source: ReferenceSource }[]): boolean {
  return references.some((ref) => ref.source.kind === "result");
}

/** 接到任务某提示词端口的提示词文本；未接为空串。 */
export function promptText(board: Board, taskId: string, port: "positive" | "negative"): string {
  const edge = board.edges.find((e) => e.to[0] === taskId && e.to[1] === port);
  const node = edge && board.nodes.find((n) => n.id === edge.from[0]);
  return node?.type === "prompt" ? node.text : "";
}

export interface ImageSource {
  nodeId: string;
  label: string;
  /** 无效来源图层身份为 null：不猜 layers/NN 路径、不回落底图，由调用方走明确素材校验失败。 */
  absPath: string | null;
  /** 接的是结果节点的第几图层（1 起）；底图 / 参考图为 null。缺图与透明探测按它分键，互不株连。 */
  sourceLayer: number | null;
}

/** 来源图层身份解析：正整数序号、在结果记录的图层表内、记录带文件名；否则为 null（无效身份）。 */
export function sourceLayerRecord(record: ResultRecord, sourceLayer: number): LayerRecord | null {
  if (!Number.isInteger(sourceLayer) || sourceLayer < 1) return null;
  const entry = record.layers?.[sourceLayer - 1];
  return entry && typeof entry.file === "string" && entry.file !== "" ? entry : null;
}

/** 结果图层文件相对数据根的路径：图层记录的 file 相对任务目录，任务目录即结果文件所在目录。 */
export function layerRelPath(node: { path: string; file: string }, file: string): string {
  return `${node.path.slice(0, node.path.length - node.file.length)}${file}`;
}

/** 缺图集合与透明通道集合共用的图片键：底图（layer 为 null）就是节点 id，图层按序号（1 起）另起一键，与底图互不株连。 */
export function imageKey(nodeId: string, layer: number | null): string {
  return layer === null ? nodeId : `${nodeId}:layer:${layer}`;
}

export interface NodeImage {
  /** 缺图 / 透明通道集合的键（见 imageKey）。 */
  key: string;
  absPath: string;
}

/** 图片节点的全部图片文件：参考图是它本身；结果节点是底图，再按序跟结果记录里的各图层。其余节点没有图片。 */
export function nodeImages(node: BoardNode, userRoot: string): NodeImage[] {
  if (node.type !== "reference" && node.type !== "result") return [];
  const main = { key: imageKey(node.id, null), absPath: resolveFromRoot(userRoot, node.path) };
  if (node.type !== "result") return [main];
  return [main, ...(node.record.layers ?? []).map((layer, i) => ({ key: imageKey(node.id, i + 1), absPath: resolveFromRoot(userRoot, layerRelPath(node, layer.file)) }))];
}

/** 任务的参考图来源，按端口顺序；结果节点回灌的是文件本身，不带会话参数。 */
export function imageSources(board: Board, taskId: string, userRoot: string): ImageSource[] {
  return imageEdges(board, taskId).flatMap((e): ImageSource[] => {
    const src = board.nodes.find((n) => n.id === e.from[0]);
    if (src?.type === "reference") return [{ nodeId: src.id, label: src.display_name, absPath: resolveFromRoot(userRoot, src.path), sourceLayer: null }];
    if (src?.type === "result") {
      // 接了某一图层：路径以结果记录里的图层记录为准（记录无效 = 身份无效，不给路径），标签点明图层序号。
      if (e.source_layer !== null) {
        const layer = sourceLayerRecord(src.record, e.source_layer);
        return [{ nodeId: src.id, label: `${src.file} 图层${e.source_layer}`, absPath: layer ? resolveFromRoot(userRoot, layerRelPath(src, layer.file)) : null, sourceLayer: e.source_layer }];
      }
      return [{ nodeId: src.id, label: src.file, absPath: resolveFromRoot(userRoot, src.path), sourceLayer: null }];
    }
    return [];
  });
}

function reachable(board: Board, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of board.edges) if (e.from[0] === id) stack.push(e.to[0]);
  }
  return false;
}

export function canConnect(board: Board, table: CapabilityTable, c: Connection): Verdict {
  if (c.source === c.target) return no("不能连到自身");
  const source = board.nodes.find((n) => n.id === c.source);
  const target = findTask(board, c.target);
  if (!source || source.type === "unknown") return no("来源节点不存在");
  if (source.type === "task") return no("结果连线由系统建立");
  if (c.sourceHandle !== "out") return no("来源端口无效");
  if (!target) return no("只能连到生成任务节点");

  const portVerdict = targetPortVerdict(board, table, c, source, target);
  if (!portVerdict.ok) return portVerdict;
  return connectionTopologyVerdict(board, c);
}

/** 端口兼容后检查占用与谱系，错误顺序保持占用优先。 */
function connectionTopologyVerdict(board: Board, c: Connection): Verdict {
  if (board.edges.some((e) => e.to[0] === c.target && e.to[1] === c.targetHandle)) return no("该端口已有连线");
  if (reachable(board, c.target, c.source)) return no("不能形成环");
  return { ok: true };
}

/** 节点身份和来源端口通过后，按目标端口种类检查输入。 */
function targetPortVerdict(board: Board, table: CapabilityTable, c: Connection, source: BoardNode, target: TaskNode): Verdict {
  const ports = taskPorts(board, table, target.id);
  const imageIndex = imagePortIndex(c.targetHandle);
  if (c.targetHandle === "positive" || c.targetHandle === "negative") {
    if (source.type !== "prompt") return no("提示词端口只接提示词节点");
    if (c.targetHandle === "negative" && !ports.negative) return no("模型不支持负向提示词");
  } else if (imageIndex !== null) {
    if (source.type === "prompt") return no("图片端口只接参考图或结果节点");
    return imageConnectionVerdict(board, table, target.id, imageIndex, referencePolicy(board, table, target.id), source);
  } else {
    return no("目标端口无效");
  }
  return { ok: true };
}

function imageConnectionVerdict(board: Board, table: CapabilityTable, taskId: string, imageIndex: number, policy: ReferencePolicy | null, source: BoardNode): Verdict {
  const count = imageEdges(board, taskId).length;
  // 名额按展开后序号算：区域叠加图也占 1 个参考图名额。
  if (imagePortSlots(board, table, taskId).length >= (policy?.maxReferences ?? 0)) return no(referenceCapReason(policy));
  const refused = sourceRuleRefusal(policy, source);
  if (refused !== null) return no(refused);
  return imageIndex !== count ? no("该端口已有连线") : { ok: true };
}

/**
 * 拖线时就地拦格式（#176）：webp 这类源图不许接上拆分任务。
 * 像素要解码才知道，由标黄（canvasNodes 按场景规则算）与提交前快照（run）接着管。
 */
function sourceRuleRefusal(policy: ReferencePolicy | null, source: BoardNode): string | null {
  if (!policy || policy.scene !== "layer_split" || !policy.layerDeclared) return null;
  if (source.type !== "reference" && source.type !== "result") return null;
  if (policy.rule.formats.includes(imageFormatOf(source.path))) return null;
  return `图层拆分参考图只接受 ${policy.rule.formats.map((f) => f.toUpperCase()).join(" / ")}`;
}

/** 名额满时的说法：拆分场景说拆分的规矩，其余沿用模型上限。 */
function referenceCapReason(policy: ReferencePolicy | null): string {
  const max = policy?.maxReferences ?? 0;
  if (max === 0) return "模型不支持图片编辑";
  return policy?.scene === "layer_split" && policy.layerDeclared ? `图层拆分只接受 ${max} 张参考图` : `参考图已达模型上限 ${max} 张`;
}

/** 追加一条用户连线（调用前应先 canConnect）；图片线总是落在下一个空端口。 */
export function connect(board: Board, c: Connection): BoardEdge[] {
  const toPort = imagePortIndex(c.targetHandle) === null ? c.targetHandle : `${IMAGE_PORT_PREFIX}${imageEdges(board, c.target).length}`;
  return [...board.edges, { from: [c.source, c.sourceHandle], to: [c.target, toPort], source_layer: null, region: null, system: false, extra: {} }];
}

function renumber(edges: BoardEdge[], taskId: string, ordered: BoardEdge[]): BoardEdge[] {
  const index = new Map(ordered.map((e, i) => [e, i]));
  return edges.map((e) => (index.has(e) ? { ...e, to: [taskId, `${IMAGE_PORT_PREFIX}${index.get(e)}`] } : e));
}

/** 删除用户连线（系统连线忽略），并让受影响任务的图片端口序号保持紧凑。 */
export function disconnect(board: Board, removed: BoardEdge[]): BoardEdge[] {
  const drop = new Set(removed.filter((e) => !e.system));
  let edges = board.edges.filter((e) => !drop.has(e));
  const tasks = new Set([...drop].filter((e) => imagePortIndex(e.to[1]) !== null).map((e) => e.to[0]));
  for (const taskId of tasks) {
    edges = renumber(edges, taskId, imageEdges({ ...board, edges }, taskId));
  }
  return edges;
}

/** 把第 from 个图片端口拖到第 to 个位置，其余顺延。 */
export function moveImagePort(board: Board, taskId: string, from: number, to: number): BoardEdge[] {
  const ordered = imageEdges(board, taskId);
  if (from < 0 || from >= ordered.length || to < 0 || to >= ordered.length || from === to) return board.edges;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  return renumber(board.edges, taskId, ordered);
}

/** 任务节点的 image_ports 与实际图片连线数保持一致（落盘字段）。 */
export function syncImagePorts(board: Board): Board {
  let changed = false;
  const nodes = board.nodes.map((n) => {
    if (n.type !== "task") return n;
    const count = imageEdges(board, n.id).length;
    if (n.image_ports === count) return n;
    changed = true;
    return { ...n, image_ports: count };
  });
  return changed ? { ...board, nodes } : board;
}

export interface Removal {
  board: Board;
  /** 实际删除的节点 id，按画板顺序（含级联的结果列）。 */
  removedIds: string[];
  /** 断开的通往保留节点的用户连线数（下游任务因此变脏）。 */
  severed: number;
}

/**
 * 删除节点：不设禁删，删任务节点级联删除其结果列（系统连线指向的结果节点），
 * 连带删除相关连线（含系统连线），受影响任务的图片端口序号紧凑。删排队 / 执行中任务前的「先取消再删」确认由界面负责。
 */
export function removeNodes(board: Board, ids: string[]): Removal {
  const gone = new Set(ids.filter((id) => board.nodes.some((n) => n.id === id)));
  for (const e of board.edges) {
    if (e.system && gone.has(e.from[0]) && board.nodes.find((n) => n.id === e.to[0])?.type === "result") gone.add(e.to[0]);
  }
  const nodes = board.nodes.filter((n) => !gone.has(n.id));
  const touched = board.edges.filter((e) => gone.has(e.from[0]) || gone.has(e.to[0]));
  let edges = board.edges.filter((e) => !touched.includes(e));
  const severed = touched.filter((e) => !e.system && gone.has(e.from[0]) && !gone.has(e.to[0])).length;
  const tasks = new Set(touched.filter((e) => !gone.has(e.to[0]) && imagePortIndex(e.to[1]) !== null).map((e) => e.to[0]));
  for (const taskId of tasks) edges = renumber(edges, taskId, imageEdges({ ...board, edges }, taskId));
  const removedIds = board.nodes.filter((n) => gone.has(n.id)).map((n) => n.id);
  return { board: syncImagePorts({ ...board, nodes, edges }), removedIds, severed };
}

export interface TaskPorts {
  /** 负向端口是否露出：模型支持，或已有连线（保留以便标红）。 */
  negative: boolean;
  /** 露出的图片端口行数：已接线数 + 未达上限时 1 个空位。 */
  imageSlots: number;
  maxReferences: number;
  /** 开关是否露出：能力支持，或已打开（保留以便标红）。 */
  layerDecomposition: boolean;
  transparentBackground: boolean;
}

export function taskPorts(board: Board, table: CapabilityTable, taskId: string): TaskPorts {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  const count = imageEdges(board, taskId).length;
  const hasNegativeEdge = board.edges.some((e) => e.to[0] === taskId && e.to[1] === "negative");
  if (!task || !model) {
    return { negative: hasNegativeEdge, imageSlots: count, maxReferences: 0, layerDecomposition: !!task?.layer_decomposition, transparentBackground: !!task?.transparent_background };
  }
  const wf = model.workflows[workflowOf(board, taskId)];
  // 名额按场景取（#176）：拆分开关打开就是拆分场景，只给声明里的那一张留空位。
  const maxReferences = referencePolicy(board, table, taskId)?.maxReferences ?? 0;
  const expanded = expandImageEdges(imageEdges(board, taskId), model).length;
  return {
    negative: isSupported(wf.supports_negative_prompt) || hasNegativeEdge,
    // 空位露出同样按展开后名额：区域叠加图占满后不再给新空位。
    imageSlots: expanded < maxReferences ? count + 1 : count,
    maxReferences,
    layerDecomposition: isSupported(wf.layer_decomposition) || task.layer_decomposition,
    transparentBackground: isSupported(model.transparent_background) || task.transparent_background,
  };
}

// ---- 编辑已提交过的提示词节点 ----

/** 提示词节点直接下游的任务里有已提交过的（有 last_submitted）。 */
function recordedTasks(board: Board, promptId: string): Set<string> {
  return new Set(
    board.edges.filter((e) => e.from[0] === promptId && findTask(board, e.to[0])?.last_submitted).map((e) => e.to[0]),
  );
}

export function hasDownstreamRecords(board: Board, promptId: string): boolean {
  return recordedTasks(board, promptId).size > 0;
}

const FORK_GAP = 24;

/** 断开并分叉：旧文本进新提示词节点（落在被编辑节点下方）接回有执行记录的任务，新文本留在被编辑节点。 */
export function forkPrompt(board: Board, promptId: string, fork: { newNodeId: string; text: string }): Board {
  const prompt = board.nodes.find((n) => n.id === promptId);
  if (prompt?.type !== "prompt") return board;
  const recorded = recordedTasks(board, promptId);
  // 旧文本在原位新建节点，被编辑节点让到下方。
  const old = { ...prompt, id: fork.newNodeId, extra: {} };
  const moved = { ...prompt, text: fork.text, pos: [prompt.pos[0], prompt.pos[1] + prompt.size[1] + FORK_GAP] as [number, number] };
  return {
    ...board,
    nodes: [...board.nodes.map((n) => (n.id === promptId ? moved : n)), old],
    edges: board.edges.map((e) => (e.from[0] === promptId && recorded.has(e.to[0]) ? { ...e, from: [fork.newNodeId, e.from[1]] } : e)),
  };
}

// ---- 参考图输入规则 ----

/** 任务当前的参考图场景与随之而来的名额 / 规则（#176）：拆分开关决定场景，值全部来自能力表。 */
export interface ReferencePolicy {
  scene: InputScene;
  maxReferences: number;
  rule: InputImageRule;
  /** 该工作流是否真的声明了拆分场景；没声明时拆分场景按工作流 / 模型级规则回落（说法也用通用口径）。 */
  layerDeclared: boolean;
}

/** 参考图名额一直按图片编辑算（接上参考图就是进入图片编辑）；拆分场景再按拆分声明收窄。 */
export function referencePolicy(board: Board, table: CapabilityTable, taskId: string): ReferencePolicy | null {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  if (!task || !model) return null;
  const layerDeclared = model.workflows.image_edit.layer_split != null;
  const scene: InputScene = task.layer_decomposition ? "layer_split" : "generate";
  return { scene, maxReferences: maxReferencesOf(model, "image_edit", scene), rule: inputImageRuleOf(model, "image_edit", scene), layerDeclared };
}

/**
 * 拆分场景的就地拦截（#176）：选完图就能说清原因，不等发请求。
 * 张数超限、格式不在声明里、字节与像素越界都在这里判；导入图带着 bytes 来时字节也当场拦。
 */
export function splitReferenceRefusal(
  board: Board,
  table: CapabilityTable,
  taskId: string,
  images: readonly { path: string; width: number; height: number; bytes?: number }[],
): string | null {
  const policy = referencePolicy(board, table, taskId);
  if (!policy || policy.scene !== "layer_split") return null;
  if (imageEdges(board, taskId).length + images.length > policy.maxReferences) return `图层拆分只接受 ${policy.maxReferences} 张参考图`;
  for (const image of images) {
    const facts = { format: imageFormatOf(image.path), bytes: image.bytes ?? 0, width: image.width, height: image.height };
    const violations = imageRuleViolations(facts, policy.rule);
    if (violations.length) return `图层拆分参考图不合规：${violations.join("；")}`;
  }
  return null;
}

/**
 * 图片节点该按哪条规则标黄（#176）：逐条下游任务按自己的场景取 —— 拆分任务用拆分声明，
 * 其余用该模型的工作流级 / 模型级规则。未接线的参考图按回退模型，结果图没接任务不提示。
 */
export function inputRulesFor(board: Board, table: CapabilityTable, nodeId: string, fallbackModel: string | null): InputImageRule[] {
  const rules: InputImageRule[] = [];
  const seen = new Set<string>();
  const downstream = board.edges.filter((e) => e.from[0] === nodeId).map((e) => findTask(board, e.to[0]));
  for (const modelId of inputRuleModels(board, nodeId, fallbackModel)) {
    const model = findModel(table, modelId);
    if (!model) continue;
    const scene: InputScene = downstream.find((t) => t?.model === modelId)?.layer_decomposition ? "layer_split" : "generate";
    const key = `${modelId}|${scene}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(inputImageRuleOf(model, "image_edit", scene));
  }
  return rules;
}

/**
 * 图片节点按哪些模型的输入规则提示：直接下游任务的模型（去重）。
 * 未接线的参考图按调用方给的回退模型（新建任务实际会用的默认模型）；结果图没接任务不提示。
 */
export function inputRuleModels(board: Board, nodeId: string, fallbackModel: string | null): string[] {
  const downstream = [...new Set(board.edges.filter((e) => e.from[0] === nodeId).flatMap((e) => findTask(board, e.to[0])?.model ?? []))];
  if (downstream.length > 0) return downstream;
  if (board.nodes.find((n) => n.id === nodeId)?.type !== "reference") return [];
  return fallbackModel ? [fallbackModel] : [];
}

// 规则判定只有一处实现（imageRule.ts）：标黄、拖线拦截、请求体与提交前快照共用同一套说法。
export { imageRuleViolations, mb } from "./imageRule";
export type { ImageFacts } from "./imageRule";
