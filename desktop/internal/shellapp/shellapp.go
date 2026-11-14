// Package shellapp 是桌面壳里不碰界面的那部分：应用信息、用户数据根与画板根、能力开关。
//
// 绑定给页面的服务只做转发（见 desktop/service.go），逻辑留在这里，go test 不需要 GUI 就能跑。
package shellapp

import (
	"os"
	"path/filepath"
)

// BoardDir 是用户数据根里的画板目录，与 Web 服务端的布局一致（见 core/board.ts）。
const BoardDir = "画板"

// Features 告诉界面哪些可选能力在这个实现里有；没有的入口按「尚不可用」隐藏。
type Features struct {
	// Generation 是生成（网关调用）：桌面壳还没有网关客户端。
	Generation bool `json:"generation"`
	// Usage 是用量统计与未引用清理：本地没有配额。
	Usage bool `json:"usage"`
	// PackExport 是画板包导出：导入是本地能力，导出还没实现。
	PackExport bool `json:"pack_export"`
}

// DesktopFeatures 返回桌面壳本切片的能力开关：三项都没有。
func DesktopFeatures() Features {
	return Features{Generation: false, Usage: false, PackExport: false}
}

// Info 是界面启动时读一次的壳信息。
type Info struct {
	// Version 是应用版本，取自 mygo.config.ts 的 version。
	Version string `json:"version"`
	// UserDataRoot 是本机唯一一份用户数据根的绝对路径。
	UserDataRoot string `json:"user_data_root"`
	// BoardRoot 是画板目录的绝对路径（用户数据根下的 画板）。
	BoardRoot string `json:"board_root"`
	// Features 是可选能力开关。
	Features Features `json:"features"`
}

// Shell 是桌面壳的应用信息源；并发调用安全（只读字段）。
type Shell struct {
	version string
	root    string
}

// New 用应用版本与已定好的用户数据根造一个 Shell。
func New(version, userDataRoot string) *Shell {
	return &Shell{version: version, root: userDataRoot}
}

// UserDataRoot 返回用户数据根。
func (s *Shell) UserDataRoot() string { return s.root }

// Info 返回壳信息，并确保用户数据根与画板目录存在（首次启动就是在这里建出来的）。
func (s *Shell) Info() (Info, error) {
	boardRoot := filepath.Join(s.root, BoardDir)
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
