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

// 只有一份：状态文件里的位置就是唯一一份用户数据根，Resolve 不产生第二份目录。
func TestResolveKeepsSingleRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "state.json")
	root := filepath.Join(base, "data")

	for i := 0; i < 3; i++ {
		if _, err := Resolve(statePath, root); err != nil {
			t.Fatalf("Resolve #%d: %v", i, err)
		}
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	if len(dirs) != 1 || dirs[0] != "data" {
		t.Fatalf("dirs = %v, want exactly [data]", dirs)
	}
}
