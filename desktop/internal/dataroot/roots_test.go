package dataroot

import (
	"path/filepath"
	"testing"
)

// Roots 是进程内共享的数据根：迁移成功后切一次，绑定给页面的服务都跟着换位置。
func TestRootsSwitchIsVisibleToEveryReader(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	roots := NewRoots(first)
	if got := roots.Current(); got != first {
		t.Fatalf("Current = %q, want %q", got, first)
	}
	roots.Switch(second)
	if got := roots.Current(); got != second {
		t.Fatalf("切换后 Current = %q, want %q", got, second)
	}
}
