// 阶段框：画在画布坐标里（ViewportPortal），框本身不挡节点的指针。标题栏只显示标题与整理模式下的阶段动作。
import { ViewportPortal } from "@xyflow/react";
import type { Stage } from "../core/board";
import type { StageBox } from "../core/stages";
import { approxSizeText, STAGE_TEXT, TIDY_TEXT } from "./boardText";

/** 整理模式下阶段框多出的内容：体量与「移出为新画板」。 */
export interface StageTidy {
  /** 阶段体量；还没量到或量不了为 null（显示未知，不当作 0）。 */
  bytes: (stageId: string) => number | null;
  /** 这一次量不出来（读不出画板或读盘失败）。 */
  sizeFailed: boolean;
  /** 移出为新画板（#93）。 */
  onMoveOut: (stageId: string) => void;
  /** 正在移出（按钮置灰）。 */
  movingOut: boolean;
}

interface Props {
  boxes: StageBox[];
  /** 整理模式；不在整理模式为 null。 */
  tidy: StageTidy | null;
}

export function StageLayer({ boxes, tidy }: Props) {
  return (
    <ViewportPortal>
      {boxes.map((box) => (
        <StageFrame key={box.stage.id} box={box} tidy={tidy} />
      ))}
    </ViewportPortal>
  );
}

interface FrameProps {
  box: StageBox;
  tidy: StageTidy | null;
}

/** 阶段框的外层：占地与收起后的样子；标题栏见 StageHeader。 */
function StageFrame({ box, tidy }: FrameProps) {
  const { stage } = box;
  // 收起时只留标题栏大小的一块，落在原框左上角。
  const style = stage.collapsed ? { transform: `translate(${box.x}px, ${box.y}px)` } : { transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height };
  return (
    <div className={frameClass(stage, tidy)} style={style} data-stage-id={stage.id}>
      <StageHeader stage={stage} amount={box.count} tidy={tidy} />
    </div>
  );
}

/** 收起的多一个 collapsed，整理模式里多一个 tidying。 */
const frameClass = (stage: Stage, tidy: StageTidy | null) => `stage-frame${stage.collapsed ? " collapsed" : ""}${tidy ? " tidying" : ""}`;

interface HeaderProps {
  stage: Stage;
  /** 收起时显示的成员数。 */
  amount: number;
  tidy: StageTidy | null;
}

/** 标题栏：标题、收起时的成员数、整理模式下的阶段动作。 */
function StageHeader({ stage, amount, tidy }: HeaderProps) {
  return (
    <div className="stage-header nodrag nopan" onPointerDown={(e) => e.stopPropagation()}>
      <span className="stage-name">{stage.name}</span>
      {stage.collapsed && <span className="stage-count">{STAGE_TEXT.count(amount)}</span>}
      {tidy && <StageTidyActions stageId={stage.id} tidy={tidy} />}
    </div>
  );
}

function StageTidyActions({ stageId, tidy }: { stageId: string; tidy: StageTidy }) {
  const bytes = tidy.bytes(stageId);
  return (
    <>
      <span className="stage-size" aria-label="阶段体量">
        {bytes !== null ? approxSizeText(bytes) : tidy.sizeFailed ? TIDY_TEXT.sizeUnknown : "…"}
      </span>
      <button type="button" className="stage-move-out" disabled={tidy.movingOut} title={TIDY_TEXT.moveOutHint} onClick={() => tidy.onMoveOut(stageId)}>
        {TIDY_TEXT.moveOut}
      </button>
    </>
  );
}
