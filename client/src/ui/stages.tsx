// 阶段框：画在画布坐标里（ViewportPortal），框本身不挡节点的指针，只有标题栏可点。
// 改名、收起 / 展开、加入所选、删除都发画板变更（core/edit），撤销 / 重做与其它编辑同一条路。
import { ViewportPortal } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { BoardChange } from "../core/edit";
import type { StageBox } from "../core/stages";
import { STAGE_TEXT } from "./boardText";

interface Props {
  boxes: StageBox[];
  /** 当前选中的节点：「加入所选」用。 */
  selected: ReadonlySet<string>;
  apply: (change: BoardChange) => void;
  /** 刚建好的阶段：标题直接进入改名。 */
  editing: string | null;
  onEditingDone: () => void;
}

export function StageLayer({ boxes, selected, apply, editing, onEditingDone }: Props) {
  return (
    <ViewportPortal>
      {boxes.map((box) => (
        <StageFrame key={box.stage.id} box={box} selected={selected} apply={apply} editing={editing === box.stage.id} onEditingDone={onEditingDone} />
      ))}
    </ViewportPortal>
  );
}

function StageFrame({ box, selected, apply, editing, onEditingDone }: { box: StageBox; selected: ReadonlySet<string>; apply: Props["apply"]; editing: boolean; onEditingDone: () => void }) {
  const { stage } = box;
  const [renaming, setRenaming] = useState(editing);
  useEffect(() => {
    if (editing) setRenaming(true);
  }, [editing]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const finish = (name: string | null) => {
    // Esc 之后输入框卸载时可能再报一次 blur：只认第一次。
    if (!input.current) return;
    input.current = null;
    setRenaming(false);
    onEditingDone();
    if (name !== null) apply({ kind: "renameStage", stageId: stage.id, name });
  };
  const fresh = [...selected].filter((id) => !stage.nodes.includes(id));
  // 收起时只留标题栏大小的一块，落在原框左上角。
  const style = stage.collapsed ? { transform: `translate(${box.x}px, ${box.y}px)` } : { transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height };
  return (
    <div className={`stage-frame${stage.collapsed ? " collapsed" : ""}`} style={style} data-stage-id={stage.id}>
      <div className="stage-header nodrag nopan" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={() => setRenaming(true)}>
        {renaming ? (
          <input
            ref={input}
            className="stage-name-input"
            aria-label="阶段名"
            defaultValue={stage.name}
            autoFocus
            onBlur={(e) => finish(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") finish(null);
            }}
          />
        ) : (
          <span className="stage-name" title="双击改名">
            {stage.name}
          </span>
        )}
        {stage.collapsed && <span className="stage-count">{STAGE_TEXT.count(box.count)}</span>}
        <button type="button" onClick={() => apply({ kind: "setStageCollapsed", stageId: stage.id, collapsed: !stage.collapsed })}>
          {stage.collapsed ? STAGE_TEXT.expand : STAGE_TEXT.collapse}
        </button>
        {!stage.collapsed && fresh.length > 0 && (
          <button type="button" onClick={() => apply({ kind: "addToStage", stageId: stage.id, nodes: fresh })}>
            {STAGE_TEXT.addSelected}
          </button>
        )}
        <button type="button" onClick={() => apply({ kind: "deleteStage", stageId: stage.id })}>
          {STAGE_TEXT.delete}
        </button>
      </div>
    </div>
  );
}
