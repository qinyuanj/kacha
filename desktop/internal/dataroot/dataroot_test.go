package dataroot

import (
	"os"
	"path/filepath"
	"testing"
)

// 首次启动：默认位置还不存在时创建出来，并记下它。
func TestResolveCreatesAndRemembers(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	root := filepath.Join(base, "data")

	got, err := Resolve(statePath, root)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != root {
		t.Fatalf("root = %q, want %q", got, root)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("user data root not created: %v", err)
	}
	state, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("state file not written: %v", err)
	}
	if want := "{\"root\":\"" + filepath.ToSlash(root) + "\"}"; string(state) != want+"\n" {
		t.Fatalf("state = %q, want %q", state, want)
	}
}

// 重启：记住的位置优先于默认位置，换默认位置也不搬数据。
func TestResolvePrefersRememberedRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	first := filepath.Join(base, "first")
	second := filepath.Join(base, "second")

	if _, err := Resolve(statePath, first); err != nil {
		t.Fatalf("first Resolve: %v", err)
	}
	got, err := Resolve(statePath, second)
	if err != nil {
		t.Fatalf("second Resolve: %v", err)
	}
	if got != first {
		t.Fatalf("root = %q, want remembered %q", got, first)
	}
	// 重复启动也只激活记下的那一份：再解析一次不会在旁边多出一份目录。
	if again, err := Resolve(statePath, second); err != nil || again != first {
		t.Fatalf("repeated Resolve = %q, %v, want remembered %q", again, err, first)
	}
	if _, err := os.Stat(second); !os.IsNotExist(err) {
		t.Fatalf("default root created despite remembered one: %v", err)
	}
}

// 记住的位置被删掉时重建同一份，而不是悄悄换到别处。
func TestResolveRecreatesRememberedRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	root := filepath.Join(base, "data")

	if _, err := Resolve(statePath, root); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	got, err := Resolve(statePath, filepath.Join(base, "other"))
	if err != nil {
		t.Fatalf("Resolve after delete: %v", err)
	}
	if got != root {
		t.Fatalf("root = %q, want %q", got, root)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("remembered root not recreated: %v", err)
	}
}

// 状态文件坏了：退回默认位置并重写，不让启动失败。
func TestResolveRepairsBrokenState(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	if err := os.WriteFile(statePath, []byte("not json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	root := filepath.Join(base, "data")

	got, err := Resolve(statePath, root)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != root {
		t.Fatalf("root = %q, want %q", got, root)
	}
	state, err := os.ReadFile(statePath)
	if err != nil || len(state) == 0 || string(state) == "not json" {
		t.Fatalf("state not repaired: %q, %v", state, err)
	}
}

// 迁移记下旧位置：新位置在下次启动时读不出来，就退回旧位置，而不是凭空建一个空数据根。
func TestResolveFallsBackToPreviousRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	old := filepath.Join(base, "旧位置")
	next := filepath.Join(base, "新位置")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatalf("建旧位置: %v", err)
	}
	if _, err := Resolve(statePath, old); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if err := Remember(statePath, next, old); err != nil {
		t.Fatalf("Remember: %v", err)
	}

	// 新位置被删掉（拔了盘、目录被清理）：退回旧位置，旧位置的数据仍可访问。
	got, err := Resolve(statePath, filepath.Join(base, "默认位置"))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != old {
		t.Fatalf("数据根 = %q, want 旧位置 %q", got, old)
	}
	// 退回之后状态文件也改回旧位置：下次启动不再尝试新位置。
	saved, ok := readState(statePath)
	if !ok || saved.Root != filepath.ToSlash(old) {
		t.Fatalf("状态文件 = %+v, want root %q", saved, filepath.ToSlash(old))
	}
}

// 新位置还在时照常使用新位置，旧位置只作为退路。
func TestResolvePrefersRememberedRootOverPrevious(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	old := filepath.Join(base, "旧位置")
	next := filepath.Join(base, "新位置")
	for _, dir := range []string{old, next} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录 %s: %v", dir, err)
		}
	}
	if err := Remember(statePath, next, old); err != nil {
		t.Fatalf("Remember: %v", err)
	}
	got, err := Resolve(statePath, filepath.Join(base, "默认位置"))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != next {
		t.Fatalf("数据根 = %q, want %q", got, next)
	}
}
