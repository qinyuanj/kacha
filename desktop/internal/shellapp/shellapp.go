// Package shellapp 是桌面壳里不碰界面的那部分：应用信息、数据根与画板根、能力开关。
//
// 绑定给页面的服务只做转发（见 desktop/service.go），逻辑留在这里，go test 不需要 GUI 就能跑。
package shellapp

import (
	"os"
	"path/filepath"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// Features 告诉界面哪些可选能力在这个实现里有；没有的入口按「尚不可用」隐藏。
type Features struct {
	// Generation 是生成（网关调用）：#152 的配置/密钥/发现与 #153 的单份生成已接通。
	Generation bool `json:"generation"`
	// Usage 是本机真实用量统计、未引用清理与回收恢复（#159）。
	Usage bool `json:"usage"`
	// PackExport 是画板包导出：由本机 Pack 服务打包，目标选择经系统对话框。
	PackExport bool `json:"pack_export"`
	// Archive 是归档与取消归档：本机存储执行画板位与只读约束，端口已接通。
	Archive bool `json:"archive"`
}

// DesktopFeatures 返回桌面壳的能力开关：归档、画板包导出、本机用量与单份生成都已接通。
func DesktopFeatures() Features {
	return Features{Generation: true, Usage: true, PackExport: true, Archive: true}
}

// Info 是界面启动时读一次的壳信息。
type Info struct {
	// Version 是应用版本，取自 mygo.config.ts 的 version。
	Version string `json:"version"`
	// UserDataRoot 是本机唯一一份数据根的绝对路径。
	UserDataRoot string `json:"user_data_root"`
	// BoardRoot 是画板目录的绝对路径（数据根下的 画板）。
	BoardRoot string `json:"board_root"`
	// Features 是可选能力开关。
	Features Features `json:"features"`
}

// Shell 是桌面壳的应用信息源；并发调用安全（只读字段）。
type Shell struct {
	version string
	root    string
}

// New 用应用版本与已定好的数据根造一个 Shell。
func New(version, userDataRoot string) *Shell {
	return &Shell{version: version, root: userDataRoot}
}

// UserDataRoot 返回数据根。
func (s *Shell) UserDataRoot() string { return s.root }

// Info 返回壳信息，并确保数据根与画板目录存在（首次启动就是在这里建出来的）。
func (s *Shell) Info() (Info, error) {
	boardRoot := filepath.Join(s.root, localstore.BoardsDir)
	for _, dir := range []string{s.root, boardRoot} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return Info{}, err
		}
	}
	return Info{
		Version:      s.version,
		UserDataRoot: s.root,
		BoardRoot:    boardRoot,
		Features:     DesktopFeatures(),
	}, nil
}
