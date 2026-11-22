package shellapp

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 桌面壳的能力开关：画板包导出、本机用量与单份生成都已接通。
func TestDesktopFeatures(t *testing.T) {
	f := DesktopFeatures(true, true)
	if !f.Generation || !f.Usage || !f.PackExport || !f.Archive || !f.Tidy {
		t.Fatalf("features = %+v, want generation/usage/pack_export/archive/tidy on", f)
	}
}

// 反馈是可选联网能力：只有配置了中继地址才开放，不能把领域意愿当成已接通。
func TestFeedbackFeatureOnlyWhenRelayConfigured(t *testing.T) {
	if !DesktopFeatures(true, true).Feedback {
		t.Fatal("配置了中继地址时 feedback 必须为 true")
	}
	if DesktopFeatures(true, false).Feedback {
		t.Fatal("没有中继地址时 feedback 必须为 false")
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

// 迁移切换数据根之后，壳信息报的是新位置，画板目录也建在新位置：重启后页面读到同一份。
func TestShellFollowsSwitchedRoot(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	roots := dataroot.NewRoots(first)
	shell := NewFollowing("0.1.0", roots)

	info, err := shell.Info()
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.UserDataRoot != first {
		t.Fatalf("数据根 = %q, want %q", info.UserDataRoot, first)
	}

	roots.Switch(second)
	info, err = shell.Info()
	if err != nil {
		t.Fatalf("切换后 Info: %v", err)
	}
	if info.UserDataRoot != second {
		t.Fatalf("切换后数据根 = %q, want %q", info.UserDataRoot, second)
	}
	if want := filepath.Join(second, localstore.BoardsDir); info.BoardRoot != want {
		t.Fatalf("切换后画板根 = %q, want %q", info.BoardRoot, want)
	}
	if stat, err := os.Stat(info.BoardRoot); err != nil || !stat.IsDir() {
		t.Fatalf("切换后画板根没建出来: %v", err)
	}
}
