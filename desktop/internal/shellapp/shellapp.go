// Package shellapp 是桌面壳里不碰界面的那部分：应用信息、数据根与画板根、能力开关。
//
// 绑定给页面的服务只做转发（见 desktop/service.go），逻辑留在这里，go test 不需要 GUI 就能跑。
package shellapp

import (
	"os"
	"path/filepath"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
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
	// Update 是可信自动更新（#164）：Go 侧真实验签并交给真实安装器。
	// 只有内置发布者公钥的发布构建才为 true；开发构建为 false，入口按「尚不可用」处理。
	Update bool `json:"update"`
	// Feedback 是可选联网反馈（#260）：桌面端使用本机授权直连 Gitea。
	Feedback bool `json:"feedback"`
}

// DesktopFeatures 返回桌面壳的能力开关：归档、画板包导出、本机用量与单份生成都已接通。
//
// Update 由 hasPublisherKey 决定：没有内置发布者公钥的构建不能验证更新签名，
// 宁可让入口显示「尚不可用」，也不能放开一条无法验签的更新路径。
func DesktopFeatures(hasPublisherKey bool) Features {
	return Features{Generation: true, Usage: true, PackExport: true, Archive: true, Update: hasPublisherKey, Feedback: true}
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

// Shell 是桌面壳的应用信息源；并发调用安全。
type Shell struct {
	version string
	root    string
	// roots 是可切换的数据根（迁移 #161）：装了它就跟它走，没装就是固定的 root。
	roots *dataroot.Roots
	// hasPublisherKey 表示这次构建内置了发布者公钥（能验证更新签名）。
	hasPublisherKey bool
}

// New 用应用版本与已定好的数据根造一个 Shell。
func New(version, userDataRoot string) *Shell {
	return &Shell{version: version, root: userDataRoot}
}

// NewFollowing 造一个跟着共享数据根走的 Shell：迁移切换后报的是新位置。
func NewFollowing(version string, roots *dataroot.Roots) *Shell {
	return &Shell{version: version, roots: roots}
}

// WithPublisherKey 告诉壳「这次构建能验证更新签名」，能力开关据此决定更新入口是否开放。
//
// 没有内置公钥的构建（开发构建、未配 updates 的发布）不能验签，
// 更新入口必须显示「尚不可用」，而不是放开一条无法验证发布者的路径。
func (s *Shell) WithPublisherKey(ok bool) *Shell {
	s.hasPublisherKey = ok
	return s
}

// UserDataRoot 返回当前数据根：迁移切换后报的是新位置。
func (s *Shell) UserDataRoot() string {
	if s.roots != nil {
		return s.roots.Current()
	}
	return s.root
}

// Version 返回应用版本，供诊断服务等绑定使用；不建目录、不读磁盘。
func (s *Shell) Version() string { return s.version }

// Info 返回壳信息，并确保数据根与画板目录存在（首次启动就是在这里建出来的）。
func (s *Shell) Info() (Info, error) {
	root := s.UserDataRoot()
	boardRoot := filepath.Join(root, localstore.BoardsDir)
	for _, dir := range []string{root, boardRoot} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return Info{}, err
		}
	}
	return Info{
		Version:      s.version,
		UserDataRoot: root,
		BoardRoot:    boardRoot,
		Features:     DesktopFeatures(s.hasPublisherKey),
	}, nil
}
