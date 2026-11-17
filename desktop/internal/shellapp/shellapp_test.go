package shellapp

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 桌面壳的能力开关：画板包导出、本机用量与单份生成都已接通。
func TestDesktopFeatures(t *testing.T) {
	f := DesktopFeatures(true)
	if !f.Generation || !f.Usage || !f.PackExport {
		t.Fatalf("features = %+v, want generation/usage/pack_export on", f)
	}
}

// Info 报出版本、数据根与画板根；画板根在数据根里，首次调用就建好。
func TestInfoReportsRootsAndCreatesBoardRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	shell := New("0.1.0", root)

	info, err := shell.Info()
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.Version != "0.1.0" {
		t.Fatalf("version = %q, want 0.1.0", info.Version)
	}
	if info.UserDataRoot != root {
		t.Fatalf("user data root = %q, want %q", info.UserDataRoot, root)
	}
	if want := filepath.Join(root, "画板"); info.BoardRoot != want {
		t.Fatalf("board root = %q, want %q", info.BoardRoot, want)
	}
	if stat, err := os.Stat(info.BoardRoot); err != nil || !stat.IsDir() {
		t.Fatalf("board root not created: %v", err)
	}
	if !info.Features.Generation || !info.Features.Usage || !info.Features.PackExport {
		t.Fatalf("features = %+v, want generation/usage/pack_export on", info.Features)
	}
}

// 画板根与 localstore.BoardsDir 是同一个目录名（目录名只在一处定义，B2）。
func TestBoardRootSharesLocalstoreBoardsDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	info, err := New("0.1.0", root).Info()
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if want := filepath.Join(root, localstore.BoardsDir); info.BoardRoot != want {
		t.Fatalf("board root = %q，期望 %q", info.BoardRoot, want)
	}
}

// 数据根不存在时 Info 也把它建出来，界面拿到的路径总是可用的。
func TestInfoCreatesMissingUserDataRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "data")
	shell := New("0.1.0", root)
	if _, err := shell.Info(); err != nil {
		t.Fatalf("Info: %v", err)
	}
	if stat, err := os.Stat(root); err != nil || !stat.IsDir() {
		t.Fatalf("user data root not created: %v", err)
	}
}
