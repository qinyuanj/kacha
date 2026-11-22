package main

import (
	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// shellService 是绑定给页面的壳服务：只做转发，逻辑在 internal/shellapp。
type shellService struct {
	shell *shellapp.Shell
}

// Info 返回版本、数据根、画板根与能力开关；首次调用会建好目录。
func (s shellService) Info() (shellapp.Info, error) {
	return s.shell.Info()
}

// SetTheme 把前端的主题档位转给 MyGo 原生主题模块（#221）：Windows 标题栏与窗口底色跟着切。
//
// 页面的主题已经在本页生效，这条通知只影响原生窗口外观：非法档位兜底为默认暗色，不 panic、
// 不往回抛错（前端的调用方也不因此阻塞切换）。
func (s shellService) SetTheme(choice string) {
	applyTheme(mygo.Theme.SetSource, choice)
}
