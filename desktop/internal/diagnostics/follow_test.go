package diagnostics

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 迁移切换数据根之后，日志写到新位置：排障信息跟着同一份数据走，不留在旧位置。
func TestDiagnosticsFollowsSwitchedRoot(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录: %v", err)
		}
	}
	roots := dataroot.NewRoots(first)
	svc := NewFollowing("0.1.0", roots, nil)
	if svc.Root() != first {
		t.Fatalf("Root = %q, want %q", svc.Root(), first)
	}
	svc.Log("ui", map[string]string{"a": "1"})
	roots.Switch(second)
	if svc.Root() != second {
		t.Fatalf("切换后 Root = %q, want %q", svc.Root(), second)
	}
}
