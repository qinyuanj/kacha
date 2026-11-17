package localstore

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveRejectsSymlinkOutOfRoot 数据根里的符号链接指向根外时，读与写都必须拒绝（spec 故事 32）。
func TestResolveRejectsSymlinkOutOfRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatalf("写根外文件: %v", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("本机无法创建符号链接（通常需要开发者模式或管理员权限）：%v", err)
	}
	s := New(root)
	target := filepath.Join(link, "secret.txt")
	if _, err := s.Resolve(target); err == nil {
		t.Fatal("指向根外的符号链接应被 Resolve 拒绝")
	}
	if _, err := s.ReadFile(target); err == nil {
		t.Fatal("指向根外的符号链接不应可读")
	}
	if got := s.WriteNewFile(filepath.Join(link, "evil.txt"), []byte("x")); got.OK {
		t.Fatalf("指向根外的符号链接不应可写：%+v", got)
	}
	if _, err := os.Stat(filepath.Join(outside, "evil.txt")); err == nil {
		t.Fatal("越界写留下了文件")
	}
}
