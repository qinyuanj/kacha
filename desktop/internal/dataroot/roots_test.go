package dataroot

import (
	"os"
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

// 并发读与切换不产生数据竞争：页面随时在读，迁移在另一条协程里切。
func TestRootsConcurrentReadAndSwitch(t *testing.T) {
	base := t.TempDir()
	roots := NewRoots(filepath.Join(base, "a"))
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			roots.Switch(filepath.Join(base, "b"))
			roots.Switch(filepath.Join(base, "a"))
		}
	}()
	for i := 0; i < 100; i++ {
		if roots.Current() == "" {
			t.Fatal("Current 读到空串")
		}
	}
	<-done
	_ = os.Getenv("")
}
