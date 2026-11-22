package main

import (
	"strings"
	"testing"
)

// 原生主题同步（#221）的绑定名与方法是页面调用约定：
// client/src/shell/desktopBridge.ts 按 Shell.SetTheme(档位) 调用。
//
// 少这个方法时切主题不会报错，只是 Windows 标题栏与窗口底色不跟着变——最难发现的那一类漏绑。
func TestBindServicesExposeShellSetTheme(t *testing.T) {
	src := generatedClient(t)
	start := strings.Index(src, "export const Shell")
	if start < 0 {
		t.Fatalf("生成的客户端里没有 Shell 服务：\n%s", src)
	}
	section := src[start:]
	if end := strings.Index(section, "} as const;"); end > 0 {
		section = section[:end]
	}
	for _, want := range []string{"Shell.Info", "Shell.SetTheme"} {
		if !strings.Contains(section, want) {
			t.Fatalf("Shell 服务里没有 %q：\n%s", want, section)
		}
	}
}
