package updateservice

import "time"

// Phase 是更新此刻处在哪一步：界面只按它分支。
type Phase string

const (
	// PhaseDisabled：这次构建没有内置发布者公钥，更新能力明确不可用。
	PhaseDisabled Phase = "disabled"
	// PhaseIdle：还没检查过。
	PhaseIdle Phase = "idle"
	// PhaseChecking：正在查发行。
	PhaseChecking Phase = "checking"
	// PhaseUpToDate：已是最新（没有更高的完整正式版本）。
	PhaseUpToDate Phase = "up_to_date"
	// PhaseAvailable：找到可用更新，还没下完。
	PhaseAvailable Phase = "available"
	// PhaseDownloading：正在下载，尚未验签。
	PhaseDownloading Phase = "downloading"
	// PhaseReady：已下载并已验签，可以安装（等用户点）。
	PhaseReady Phase = "ready"
	// PhaseInstalling：已交给真实安装器。
	PhaseInstalling Phase = "installing"
	// PhaseError：这一轮失败，旧版本照常可用。
	PhaseError Phase = "error"
)

// Snapshot 是页面轮询的更新状态。
//
// Installable 只在「包已下载且发布者签名已在本地验过」时为 true；下载完成但没验签
// 的包一律 false，界面不提供安装按钮。
type Snapshot struct {
	Phase Phase `json:"phase"`
	// Current 是当前运行版本，Version 是选中更新的版本。
	Current string `json:"current"`
	Version string `json:"version"`
	// Notes 是更新说明（发布侧写的一级标题 + 条目）。
	Notes string `json:"notes"`
	// PageURL 是这次发行的页面，仅作发行信息保留；更新入口只走自动安装。
	PageURL string `json:"page_url"`
	// Downloaded 与 Total 是下载进度（字节）；未下载时都为 0。
	Downloaded int64 `json:"downloaded"`
	Total      int64 `json:"total"`
	// Verified 表示这个包的发布者签名已在本机验过。
	Verified bool `json:"verified"`
	// Installable 是「可以点安装」：已验签且还没在装。
	Installable bool `json:"installable"`
	// Error 是这一轮的失败原因（可显示）。
	Error string `json:"error"`
	// CheckedAt 是最近一次检查结束的时间。
	CheckedAt time.Time `json:"checked_at"`
}
