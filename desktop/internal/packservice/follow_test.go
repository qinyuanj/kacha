package packservice

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/packexport"
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
// 迁移复制期间不开新的导入与导出：两边都在搬同一份文件，且完成前导入写进旧位置会丢。
// 拦下时给明确结局（kind = moving），迁移结束后恢复。
func TestPackWorkIsRejectedWhileMovingRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "旧")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	pack := filepath.Join(base, "板.ugcpack")
	if err := os.WriteFile(pack, []byte("not-a-zip"), 0o644); err != nil {
		t.Fatalf("造包: %v", err)
	}
	roots := dataroot.NewRoots(root)
	svc := NewFollowing(roots)

	if !roots.BeginMove() {
		t.Fatal("开始迁移应当成功")
	}
	if out := svc.Start(pack); out.OK || out.Kind != KindMoving {
		t.Fatalf("迁移期间导入结局 = %+v, want kind %q", out, KindMoving)
	}
	if out := svc.Export(filepath.Join(base, "导出.ugcpack"), packexport.Spec{}, false); out.OK || out.Kind != KindMoving {
		t.Fatalf("迁移期间导出结局 = %+v, want kind %q", out, KindMoving)
	}
	if snap := svc.Snapshot(); snap.Running {
		t.Fatal("被拦下的导入留下了 running 状态")
	}
	if snap := svc.ExportSnapshot(); snap.Running {
		t.Fatal("被拦下的导出留下了 running 状态")
	}
	roots.EndMove()
	// 迁移结束后不再是被拦的结局（这里的包是坏的，会是别的明确失败）。
	if out := svc.Start(pack); out.Kind == KindMoving {
		t.Fatalf("迁移结束后导入仍被拦下: %+v", out)
	}
}
