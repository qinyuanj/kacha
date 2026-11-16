// 阶段框：画在画布坐标里（ViewportPortal），框本身不挡节点的指针，只有标题栏可点。
// 改名、收起 / 展开、加入所选、删除都发画板变更（core/edit），撤销 / 重做与其它编辑同一条路。
import { ViewportPortal } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { Stage } from "../core/board";
import type { BoardChange } from "../core/edit";
import type { StageBox } from "../core/stages";
import { approxSizeText, STAGE_TEXT, SUGGEST_KEEP_TEXT, TIDY_TEXT } from "./boardText";

/** 把一次画板变更交回画布（由它交给 core/edit）。 */
type Apply = (change: BoardChange) => void;

/** 整理模式下阶段框多出的内容：体量与「收掉未定稿」。 */
export interface StageTidy {
  /** 阶段体量；还没量到为 null。 */
  bytes: (stageId: string) => number | null;
  /** 「收掉未定稿」会收掉几张。 */
  prunable: (stageId: string) => number;
  onPrune: (stageId: string) => void;
  /** 这个阶段里建议保留的张数（#144）。 */
  keepable: (stageId: string) => number;
  /** 把这个阶段里建议保留的结果标成定稿（一步撤销）。 */
  onKeep: (stageId: string) => void;
  /** 移出为新画板（#93）。 */
  onMoveOut: (stageId: string) => void;
  /** 正在移出（按钮置灰）。 */
  movingOut: boolean;
}

interface Props {
  boxes: StageBox[];
  /** 当前选中的节点：「加入所选」用。 */
  selected: ReadonlySet<string>;
  apply: Apply;
  /** 刚建好的阶段：标题直接进入改名。 */
  editing: string | null;
  onEditingDone: () => void;
  /** 整理模式；不在整理模式为 null。 */
  tidy: StageTidy | null;
}

export function StageLayer({ boxes, selected, apply, editing, onEditingDone, tidy, readOnly }: Props & { readOnly?: boolean }) {
  return (
    <ViewportPortal>
      {boxes.map((box) => (
        <StageFrame key={box.stage.id} box={box} selected={selected} apply={apply} editing={editing === box.stage.id} onEditingDone={onEditingDone} tidy={tidy} readOnly={readOnly} />
      ))}
    </ViewportPortal>
  );
}

interface FrameProps {
  box: StageBox;
  selected: ReadonlySet<string>;
  apply: Apply;
  editing: boolean;
  onEditingDone: () => void;
  tidy: StageTidy | null;
  readOnly?: boolean;
}

/** 阶段框的外层：占地与收起后的样子；标题栏见 StageHeader。 */
function StageFrame({ box, selected, apply, editing, onEditingDone, tidy, readOnly }: FrameProps) {
  const { stage } = box;
  const [renaming, setRenaming] = useState(editing);
  useEffect(() => {
    if (editing) setRenaming(true);
  }, [editing]);
  // 收起时只留标题栏大小的一块，落在原框左上角。
  const style = stage.collapsed ? { transform: `translate(${box.x}px, ${box.y}px)` } : { transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height };
  return (
    <div className={frameClass(stage, tidy)} style={style} data-stage-id={stage.id}>
      <StageHeader stage={stage} amount={box.count} fresh={freshOf(stage, selected)} apply={apply} renaming={renaming} onRenaming={setRenaming} onEditingDone={onEditingDone} tidy={tidy} readOnly={readOnly} />
    </div>
  );
}

/** 收起的多一个 collapsed，整理模式里多一个 tidying。 */
const frameClass = (stage: Stage, tidy: StageTidy | null) => `stage-frame${stage.collapsed ? " collapsed" : ""}${tidy ? " tidying" : ""}`;

/** 选区里还没进这个阶段的节点：「加入所选」加的就是这些。 */
const freshOf = (stage: Stage, selected: ReadonlySet<string>) => [...selected].filter((id) => !stage.nodes.includes(id));

interface HeaderProps {
  stage: Stage;
  /** 收起时显示的成员数。 */
  amount: number;
  /** 选区里还没进这个阶段的节点。 */
  fresh: string[];
  apply: Apply;
  renaming: boolean;
  onRenaming: (renaming: boolean) => void;
  onEditingDone: () => void;
  tidy: StageTidy | null;
  readOnly?: boolean;
}

/** 标题栏：改名框或标题、收起时的成员数、整理动作、阶段自己的按钮。 */
function StageHeader({ stage, amount, fresh, apply, renaming, onRenaming, onEditingDone, tidy, readOnly }: HeaderProps) {
  const finish = (name: string | null) => {
    onRenaming(false);
    onEditingDone();
    if (name !== null) apply({ kind: "renameStage", stageId: stage.id, name });
  };
  return (
    <div className="stage-header nodrag nopan" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={() => !readOnly && onRenaming(true)}>
      {renaming ? (
        <StageNameInput name={stage.name} onDone={finish} />
      ) : (
        <span className="stage-name" title="双击改名">
          {stage.name}
        </span>
      )}
      {stage.collapsed && <span className="stage-count">{STAGE_TEXT.count(amount)}</span>}
      {tidy && <StageTidyActions stageId={stage.id} tidy={tidy} />}
      <StageActions stage={stage} fresh={fresh} apply={apply} readOnly={readOnly} />
    </div>
  );
}

/** 改名输入框：Enter / 失焦提交，Esc 放弃。Esc 之后输入框卸载时可能再报一次 blur：只认第一次。 */
function StageNameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (!input.current) return;
    input.current = null;
    onDone(value);
  };
  return (
    <input
      ref={input}
      className="stage-name-input"
      aria-label="阶段名"
      defaultValue={name}
      autoFocus
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}

interface ActionsProps {
  stage: Stage;
  /** 选区里还没进这个阶段的节点。 */
  fresh: string[];
  apply: Apply;
  readOnly?: boolean;
}

/** 阶段自己的按钮：收起 / 展开、加入所选、删除。 */
function StageActions({ stage, fresh, apply, readOnly }: ActionsProps) {
  return (
    <>
      {!readOnly && (
        <button type="button" onClick={() => apply({ kind: "setStageCollapsed", stageId: stage.id, collapsed: !stage.collapsed })}>
          {stage.collapsed ? STAGE_TEXT.expand : STAGE_TEXT.collapse}
        </button>
      )}
      {!readOnly && !stage.collapsed && fresh.length > 0 && (
        <button type="button" onClick={() => apply({ kind: "addToStage", stageId: stage.id, nodes: fresh })}>
          {STAGE_TEXT.addSelected}
        </button>
      )}
      {!readOnly && (
        <button type="button" onClick={() => apply({ kind: "deleteStage", stageId: stage.id })}>
          {STAGE_TEXT.delete}
        </button>
      )}
    </>
  );
}

function StageTidyActions({ stageId, tidy }: { stageId: string; tidy: StageTidy }) {
  const bytes = tidy.bytes(stageId);
  const n = tidy.prunable(stageId);
  const keep = tidy.keepable(stageId);
  return (
    <>
      <span className="stage-size" aria-label="阶段体量">
        {bytes === null ? "…" : approxSizeText(bytes)}
      </span>
      {/* 建议保留只是建议：点了才成为定稿（一步撤销）。没有建议时置灰。 */}
      <button type="button" className="stage-keep" disabled={keep === 0} title={keep === 0 ? SUGGEST_KEEP_TEXT.nothingToKeep : undefined} onClick={() => tidy.onKeep(stageId)}>
        {SUGGEST_KEEP_TEXT.keep(keep)}
      </button>
      <button type="button" className="stage-prune" disabled={n === 0} title={n === 0 ? TIDY_TEXT.nothingToPrune : undefined} onClick={() => tidy.onPrune(stageId)}>
        {TIDY_TEXT.prune(n)}
      </button>
      <button type="button" className="stage-move-out" disabled={tidy.movingOut} title={TIDY_TEXT.moveOutHint} onClick={() => tidy.onMoveOut(stageId)}>
        {TIDY_TEXT.moveOut}
      </button>
    </>
  );
}
