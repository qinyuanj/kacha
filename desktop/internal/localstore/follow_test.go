package localstore

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 迁移切换数据根之后，同一个 Store 读写的是新位置：不必重建服务，也不必重启。
func TestStoreFollowsSwitchedRoot(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(filepath.Join(dir, BoardsDir), 0o755); err != nil {
			t.Fatalf("建目录: %v", err)
		}
	}
	roots := dataroot.NewRoots(first)
	store := NewFollowing(roots)

	if store.Root() != first {
		t.Fatalf("Root = %q, want %q", store.Root(), first)
	}
	if out := store.WriteMeta("settings.json", `{"format_version":1}`); !out.OK {
		t.Fatalf("WriteMeta: %+v", out)
	}
	if _, err := os.Stat(filepath.Join(first, MetaDir, "settings.json")); err != nil {
		t.Fatalf("元数据没写进旧位置: %v", err)
	}

	roots.Switch(second)
	if store.Root() != second {
		t.Fatalf("切换后 Root = %q, want %q", store.Root(), second)
	}
	if store.BoardDir() != filepath.Join(second, BoardsDir) {
		t.Fatalf("BoardDir = %q, want %q", store.BoardDir(), filepath.Join(second, BoardsDir))
	}
	if out := store.WriteMeta("settings.json", `{"format_version":2}`); !out.OK {
		t.Fatalf("WriteMeta: %+v", out)
	}
	if _, err := os.Stat(filepath.Join(second, MetaDir, "settings.json")); err != nil {
		t.Fatalf("切换后元数据没写进新位置: %v", err)
	}
	// 越界判定也跟着新位置：旧位置现在是数据根之外。
	if _, err := store.Resolve(filepath.Join(first, "画板", "a.ugcboard.json")); err == nil {
		t.Fatal("切换后旧位置的路径应当越界")
	}
}
