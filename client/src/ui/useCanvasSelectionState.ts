// 画布的选区，以及三类跟着选区 / 画板变化的本地状态：节点与连线选区、提示词未提交草稿、
// 「以此继续编辑」的一次性聚焦请求、任务节点原地展开。撤销 / 删除后不在画板上的条目在这里清掉；
// 这些状态都不存盘（手动展开只在本地，见 core/expand）。
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Board } from "../core/board";
import { expandedTasks, forgetOnSelectionChange, type ExpandOverrides } from "../core/expand";
import type { Selection } from "./useCanvasInteraction";

/** 画板上现有节点 id：清理选区和本地状态时用。 */
function presentIds(board: Board): ReadonlySet<string> {
  return new Set(board.nodes.map((n) => n.id));
}

/** id 是否全在画板上；全在时调用方保留原对象（引用不变就不触发重渲染）。 */
function allPresent(ids: Iterable<string>, present: ReadonlySet<string>): boolean {
  for (const id of ids) {
    if (!present.has(id)) return false;
  }
  return true;
}

export interface CanvasSelectionState {
  selectedNodes: ReadonlySet<string>;
  selectedEdges: ReadonlySet<string>;
  setSelectedNodes: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setSelectedEdges: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** 选中节点的同步视图：事件回调与画板变更当场要读最新值。 */
  selectedRef: MutableRefObject<ReadonlySet<string>>;
  /** 交给 useCanvasInteraction 的选区句柄（ref + setter）。 */
  selection: Selection;
  /** 设置已原地展开的任务节点。 */
  expanded: ReadonlySet<string>;
  setExpandOverrides: Dispatch<SetStateAction<ExpandOverrides>>;
  /** 聚焦请求的 state 视图（只用来把 autoFocus 传给节点触发重渲染）；权威值是 ref。 */
  focusPrompt: string | null;
  focusPromptRef: MutableRefObject<string | null>;
  requestPromptFocus: (promptId: string | null) => void;
  /** 提示词等待三选一的未提交文本：按节点 id 存在画布上。 */
  promptDrafts: ReadonlyMap<string, string>;
  setPromptDrafts: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
}

export function useCanvasSelectionState(board: Board): CanvasSelectionState {
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());

  const selectedRef = useRef(selectedNodes);
  selectedRef.current = selectedNodes;
  // 撤销 / 重做会让选中的节点消失：丢掉不在画板上的选中，免得「运行选中」与复制落在空集上。
  useEffect(() => {
    const present = presentIds(board);
    setSelectedNodes((s) => (allPresent(s, present) ? s : new Set([...s].filter((id) => present.has(id)))));
  }, [board.nodes]);
  const selectedEdgesRef = useRef(selectedEdges);
  selectedEdgesRef.current = selectedEdges;

  /**
   * 「以此继续编辑」新建提示词的一次性聚焦请求。两处显式清除，不依赖 xyflow 是否把还没测量的视口外节点强制渲染一次：
   * 节点显示出来并取走请求时（takePromptFocus）；视口开始移动时（onMoveStart）——视口外的节点要等视口移动才会挂载，
   * 请求活不到那时，日后进入视口不会抢焦点。ref 是权威值（同步清除）；state 只用来把 autoFocus 传给节点触发重渲染。
   */
  const [focusPrompt, setFocusPrompt] = useState<string | null>(null);
  const focusPromptRef = useRef<string | null>(null);
  const requestPromptFocus = useCallback((promptId: string | null) => {
    focusPromptRef.current = promptId;
    setFocusPrompt(promptId);
  }, []);

  /** 提示词等待三选一的未提交文本：存在画布而不是节点里，节点离开视口卸载再挂载时仍在。 */
  const [promptDrafts, setPromptDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  // 撤销 / 删除后不在画板上的提示词不留未提交文本。
  useEffect(() => {
    const present = presentIds(board);
    setPromptDrafts((d) => (allPresent(d.keys(), present) ? d : new Map([...d].filter(([id]) => present.has(id)))));
  }, [board.nodes]);

  /** 任务节点参数的原地展开：默认跟随选中，手动切换只在本地、不存盘（见 core/expand）。 */
  const [expandOverrides, setExpandOverrides] = useState<ExpandOverrides>(new Map());
  const expanded = useMemo(() => expandedTasks(expandOverrides, selectedNodes, board.nodes.map((n) => n.id)), [expandOverrides, selectedNodes, board.nodes]);
  const expandSelection = useRef(selectedNodes);
  useEffect(() => {
    const before = expandSelection.current;
    expandSelection.current = selectedNodes;
    setExpandOverrides((o) => forgetOnSelectionChange(o, before, selectedNodes));
  }, [selectedNodes]);
  // 撤销 / 删除后不在画板上的任务不留展开状态。
  useEffect(() => {
    const present = presentIds(board);
    setExpandOverrides((o) => (allPresent(o.keys(), present) ? o : new Map([...o].filter(([id]) => present.has(id)))));
  }, [board.nodes]);

  const selection = useMemo<Selection>(() => ({ nodes: selectedRef, edges: selectedEdgesRef, setNodes: setSelectedNodes, setEdges: setSelectedEdges }), []);

  return {
    selectedNodes, selectedEdges, setSelectedNodes, setSelectedEdges, selectedRef, selection,
    expanded, setExpandOverrides, focusPrompt, focusPromptRef, requestPromptFocus, promptDrafts, setPromptDrafts,
  };
}
