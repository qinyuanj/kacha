// 顶栏单一版本入口（#269）：常驻当前安装版本号，点开本地当前版及历史更新说明。
//
// 信任规则不在页面：选版、验签与真实安装器都在 Go 侧（desktop/internal/updateservice）。
// 页面只做三件事：固定显示当前版本；按快照表达状态；用户点安装时先走准备（等任务、严格保存）再调安装。
// 读状态 / 排程与安装流程在 ui/useUpdate.ts，空闲自动安装在 core/updateAutoInstall.ts；
// 工作台负责把那一份接线递给这里，这里只留 DOM。
import { useShell } from "./shell";
import { updateButtonView } from "./updateButtonView";
import { updateSectionView } from "./updateSectionView";
import type { UpdateControl } from "./useUpdate";
import type { UpdatePhase } from "../core/update";

/** 快照与动作都从外面来；版本与打开说明也由工作台接线。 */
export type UpdateToolbarControlProps = UpdateControl & {
  version: string;
  onOpenChangelog(): void;
};

/** 有更新可推进的阶段：只有这些阶段才摆安装按钮。 */
const UPDATE_PHASES: ReadonlySet<UpdatePhase> = new Set(["available", "downloading", "ready", "installing"]);

/** 进度、可安装提示和安装中需要文字说明；其余状态由提示与无障碍名称承担。 */
const VISIBLE_STATUS_PHASES: ReadonlySet<UpdatePhase> = new Set(["downloading", "ready", "installing"]);

/** 没有更新时不摆安装按钮，首页不要常驻一个灰按钮。 */
function hasUpdate(phase: UpdatePhase): boolean {
  return UPDATE_PHASES.has(phase);
}

/** 安装按钮的字：准备中与安装中优先。 */
function installLabel(preparing: boolean, phase: UpdatePhase): string {
  if (preparing) return "准备中…";
  return phase === "installing" ? "安装中…" : "下载并安装";
}

/** 要摆出来的失败原因：检查失败给原因，准备失败给原因。 */
function errorText(error: string, prepareError: string): string {
  if (prepareError) return prepareError;
  return error;
}

/**
 * 版本号旁的唯一入口：能力关闭也保留版本号；任何状态下点击只打开本地更新说明。
 * 状态长句由主界面提示条负责，这里只留必要的进度 / 就绪文字、失败原因与安装按钮。
 */
export function UpdateToolbarControl({
  snapshot,
  state,
  install,
  version,
  onOpenChangelog,
}: UpdateToolbarControlProps) {
  const port = useShell();
  const updateEnabled = Boolean(port.features.update);

  const view = updateSectionView({ snapshot, preparing: state.preparing, prepareError: state.prepareError || state.installError });
  const button = updateButtonView(snapshot, version, updateEnabled);
  const failed = snapshot.phase === "error";
  const reason = errorText(failed ? snapshot.error : "", view.prepareError);
  const visibleStatus = updateEnabled && VISIBLE_STATUS_PHASES.has(snapshot.phase) ? view.status : "";
  const accessibleName = `当前版本 ${version}，${button.status}，查看更新说明`;

  return (
    <div className="topbar-update" aria-label="更新入口">
      <button
        className={`topbar-button topbar-version topbar-update-btn topbar-update-${button.tone}`}
        onClick={onOpenChangelog}
        aria-haspopup="dialog"
        aria-label={accessibleName}
        title={accessibleName}
        data-update-tone={button.tone}
      >
        {version}
      </button>
      {visibleStatus && <span className="topbar-update-status">{visibleStatus}</span>}
      {updateEnabled && hasUpdate(snapshot.phase) && (
        <button
          className="topbar-button topbar-update-install"
          onClick={() => void install()}
          disabled={!view.canInstall || state.preparing}
        >
          {installLabel(state.preparing, snapshot.phase)}
        </button>
      )}
      {reason && <span className="topbar-update-error">{reason}</span>}
    </div>
  );
}
