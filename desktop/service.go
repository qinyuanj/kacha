package main

import (
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// shellService 是绑定给页面的壳服务：只做转发，逻辑在 internal/shellapp。
type shellService struct {
	shell *shellapp.Shell
}

// Info 返回版本、用户数据根、画板根与能力开关；首次调用会建好目录。
func (s shellService) Info() (shellapp.Info, error) {
	return s.shell.Info()
}
