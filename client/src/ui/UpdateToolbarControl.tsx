// 首页版本号旁的更新入口（#164、#180、#181）：检查更新与下载安装。
//
// 信任规则不在页面：选版、验签与真实安装器都在 Go 侧（desktop/internal/updateservice）。
// 页面只做两件事：按快照显示状态；用户点安装时先走准备（等任务、严格保存）再调安装。
// 读状态 / 排程与安装流程在 ui/useUpdate.ts，空闲自动安装在 core/updateAutoInstall.ts；
// 工作台负责把那一份接线递给这里（#180 起主界面与本段共用同一份），这里只留 DOM。
// #181 起入口放在首页版本号旁，不再藏在高级设置里。
import { useShell } from "./shell";
import { updateSectionView } from "./updateSectionView";
import type { UpdateControl } from "./useUpdate";
import type { UpdatePhase } from "../core/update";

/** 快照与动作都从外面来，这一段不再自己起轮询与准备协调器。 */
export type UpdateToolbarControlProps = UpdateControl;

/** 有更新可推进的阶段：只有这些阶段才摆安装按钮。 */
const UPDATE_PHASES: ReadonlySet<UpdatePhase> = new Set(["available", "downloading", "ready", "installing"]);

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
 * 版本号旁的入口：能力没开时整段不显示；有新版本时多一个「下载并安装」。
 * 状态长句仍由主界面提示条负责，这里只留入口、失败原因与手动下载。
 */
export function UpdateToolbarControl({ snapshot, state, check, install }: UpdateToolbarControlProps) {
  const port = useShell();

  if (!port.features.update) return null;

  const view = updateSectionView({ snapshot, preparing: state.preparing, prepareError: state.prepareError || state.installError });
  const checking = snapshot.phase === "checking";
  const failed = snapshot.phase === "error";
  const reason = errorText(failed ? snapshot.error : "", view.prepareError);

  return (
    <div className="topbar-update" aria-label="更新入口">
      <button className="topbar-button" onClick={() => check()} disabled={!view.canCheck} title={view.status}>
        {checking ? "检查中…" : "检查更新"}
      </button>
      {hasUpdate(snapshot.phase) && (
        <button
          className="topbar-button topbar-update-install"
          onClick={() => void install()}
          disabled={!view.canInstall || state.preparing}
        >
          {installLabel(state.preparing, snapshot.phase)}
        </button>
      )}
      {view.pageUrl && (
        <a className="topbar-update-link" href={view.pageUrl} target="_blank" rel="noreferrer">
          手动下载
        </a>
      )}
      {reason && <span className="topbar-update-error">{reason}</span>}
    </div>
  );
}
