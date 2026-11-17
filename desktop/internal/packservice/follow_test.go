package packservice

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 迁移切换数据根之后，导入与导出都落到新位置：服务跟着共享数据根走，不必重建。
func TestPackServiceFollowsSwitchedRoot(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录: %v", err)
		}
	}
	roots := dataroot.NewRoots(first)
	svc := NewFollowing(roots)
	if svc.Root() != first {
		t.Fatalf("Root = %q, want %q", svc.Root(), first)
	}
	roots.Switch(second)
	if svc.Root() != second {
		t.Fatalf("切换后 Root = %q, want %q", svc.Root(), second)
	}
}
