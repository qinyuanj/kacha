package localservice

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// withSaveDialog 临时替换「另存为」对话框，不弹窗。
func withSaveDialog(t *testing.T, fn func(mygo.SaveDialogOptions) (string, error)) {
	t.Helper()
	old := saveDialog
	saveDialog = fn
	t.Cleanup(func() { saveDialog = old })
}

// TestSaveCopyAsWritesChosenFile 复制图片失败后的「另存为…」要把字节写到用户选的位置（A2）。
func TestSaveCopyAsWritesChosenFile(t *testing.T) {
	store := localstore.New(t.TempDir())
	src := filepath.Join(store.Root(), "参考", "cat.png")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	want := []byte{137, 80, 78, 71, 1, 2, 3}
	if err := os.WriteFile(src, want, 0o644); err != nil {
		t.Fatalf("写源图: %v", err)
	}
	dest := filepath.Join(t.TempDir(), "saved.png")
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })

	out, err := New(store).SaveCopyAs(src)
	if err != nil {
		t.Fatalf("SaveCopyAs: %v", err)
	}
	if !out.OK {
		t.Fatalf("结局 = %+v，期望成功", out)
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("落盘内容 = %v, %v；期望 %v", got, err, want)
	}
}

// TestSaveCopyAsCancelIsNoError 用户取消对话框不是错误，也不写文件。
func TestSaveCopyAsCancelIsNoError(t *testing.T) {
	store := localstore.New(t.TempDir())
	src := filepath.Join(store.Root(), "cat.png")
	if err := os.WriteFile(src, []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatalf("写源图: %v", err)
	}
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return "", nil })
	out, err := New(store).SaveCopyAs(src)
	if err != nil {
		t.Fatalf("取消不该报错：%v", err)
	}
	if out.OK || out.Kind != "cancelled" {
		t.Fatalf("取消结局 = %+v，期望 cancelled", out)
	}
}

// TestSaveCopyAsRejectsOutsideRoot 数据根外的路径不许读出来另存。
func TestSaveCopyAsRejectsOutsideRoot(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "secret.png")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatalf("写根外文件: %v", err)
	}
	store := localstore.New(filepath.Join(base, "root"))
	if _, err := New(store).SaveCopyAs(outside); err == nil {
		t.Fatal("越出数据根的路径应被拒绝")
	}
}
