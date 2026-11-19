// 自动更新（#164、#180）：检查、状态与安装入口都在这一段，SettingsPanel 只负责摆放。
//
// 信任规则不在页面：选版、验签与真实安装器都在 Go 侧（desktop/internal/updateservice）。
// 页面只做两件事：按快照显示状态；用户点安装时先走准备（等任务、严格保存）再调安装。
// 读状态 / 排程与安装流程在 ui/useUpdate.ts，空闲自动安装在 core/updateAutoInstall.ts；
// 工作台负责把那一份接线递给这里（#180 起主界面与本段共用同一份），这里只留 DOM。
import { useShell } from "./shell";
import { updateSectionView } from "./updateSectionView";
import type { UpdateControl } from "./useUpdate";

/** 快照与动作都从外面来，这一段不再自己起轮询与准备协调器。 */
export type UpdateSectionProps = UpdateControl;

/** 按钮文字：准备中 / 安装中优先，其余按阶段。 */
function checkLabel(checking: boolean): string {
  return checking ? "检查中…" : "检查更新";
}

function installLabel(preparing: boolean, installing: boolean): string {
  if (preparing) return "准备中…";
  return installing ? "安装中…" : "下载并安装";
}

/** 更新那一行：能力没开时整段不显示（入口按「尚不可用」）。 */
export function UpdateSection({ snapshot, state, check, install }: UpdateSectionProps) {
  const port = useShell();

  if (!port.features.update) return null;

  const view = updateSectionView({ snapshot, preparing: state.preparing, prepareError: state.prepareError || state.installError });

  return (
    <>
      <div className="form-row">
        <span>自动更新</span>
        <button onClick={() => check()} disabled={!view.canCheck}>{checkLabel(snapshot.phase === "checking")}</button>
        <button className="primary" onClick={() => void install()} disabled={!view.canInstall}>
          {installLabel(state.preparing, snapshot.phase === "installing")}
        </button>
      </div>
      <div className="muted small form-hint">{view.status}</div>
      {view.pageUrl && (
        <div className="muted small form-hint">
          <a href={view.pageUrl} target="_blank" rel="noreferrer">手动下载 {view.version}</a>
        </div>
      )}
      {view.prepareError && <div className="form-error">{view.prepareError}</div>}
    </>
  );
}
